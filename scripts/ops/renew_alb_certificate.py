#!/usr/bin/env python3
"""Issue/renew with DNS-01, replace the ALB default certificate, verify both VIPs."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import shlex
import shutil
import socket
import ssl
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]


def cloud(product, action, region=None, **args):
    command = [os.environ.get('ALIYUN_BIN', 'aliyun'), product, action]
    if region:
        command += ['--RegionId', region]
    if product == 'alb':
        command += ['--force']
    for key, value in args.items():
        command += ['--' + key, str(value)]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    # Never echo a failed command: the certificate import carries a private key.
    if result.returncode:
        raise RuntimeError('Cloud API failed: ' + product + '/' + action)
    return json.loads(result.stdout)


def peer(ip, host):
    with socket.create_connection((ip, 443), timeout=15) as connection:
        with ssl.create_default_context().wrap_socket(connection, server_hostname=host) as tls:
            cert = tls.getpeercert()
            return {'fingerprint': hashlib.sha256(tls.getpeercert(binary_form=True)).hexdigest(),
                    'expires': ssl.cert_time_to_seconds(cert['notAfter']),
                    'sans': sorted(value for kind, value in cert['subjectAltName'] if kind == 'DNS')}


def wait_for_binding(config, certificate_id, fingerprint, timeout=180):
    deadline = time.monotonic() + timeout
    last_error = ''
    while time.monotonic() < deadline:
        try:
            listener = cloud('alb', 'GetListenerAttribute', config['region'], ListenerId=config['listener_id'])
            if [row['CertificateId'] for row in listener['Certificates']] != [certificate_id]:
                raise RuntimeError('Certificate binding has not converged')
            for ip in config['verify_ips']:
                for host in config['verify_hosts']:
                    if peer(ip, host)['fingerprint'] != fingerprint:
                        raise RuntimeError('ALB served another certificate')
            return
        except Exception as error:
            last_error = type(error).__name__
            time.sleep(3)
    raise RuntimeError('Certificate verification timed out: ' + last_error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=pathlib.Path, default=ROOT / 'deploy/alb-certificate.json')
    parser.add_argument('--state-dir', type=pathlib.Path, default=ROOT / '.deploy-certs')
    parser.add_argument('--check', action='store_true', help='Read-only certificate and listener check')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    listener = cloud('alb', 'GetListenerAttribute', config['region'], ListenerId=config['listener_id'])
    if listener['LoadBalancerId'] != config['load_balancer_id'] or listener['ListenerPort'] != 443:
        raise RuntimeError('Listener identity mismatch')
    if len(listener['Certificates']) != 1:
        raise RuntimeError('Multiple listener certificates require explicit review; no binding changed')
    old_id = listener['Certificates'][0]['CertificateId']
    before = peer(config['verify_ips'][0], config['verify_hosts'][0])
    if not set(before['sans']).issubset(config['domains']):
        raise RuntimeError('Configured SANs would drop existing certificate coverage')
    remaining = (before['expires'] - time.time()) / 86400
    print(json.dumps({'certificate_id': old_id, 'remaining_days': round(remaining, 1),
                      'expires_utc': datetime.datetime.fromtimestamp(before['expires'], datetime.timezone.utc).isoformat()}), flush=True)
    if args.check or remaining > config['renew_before_days']:
        return
    state = args.state_dir.resolve()
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    state.chmod(0o700)
    hook = ROOT / 'scripts/ops/certificate_dns.py'
    certbot = os.environ.get('CERTBOT_BIN') or shutil.which('certbot')
    if not certbot:
        raise RuntimeError('Certbot is required; install it before renewal')
    env = dict(os.environ, JUNSHI_CERT_ZONE=config['dns_zone'], JUNSHI_CERT_STATE=str(state),
               JUNSHI_CERT_DOMAINS=json.dumps(config['domains']))
    cert_dir = state / 'config/live' / config['cert_name']
    cert_path, key_path = cert_dir / 'fullchain.pem', cert_dir / 'privkey.pem'
    renew = True
    if cert_path.exists():
        decoded = ssl._ssl._test_decode_cert(str(cert_path))
        renew = ssl.cert_time_to_seconds(decoded['notAfter']) <= time.time() + config['renew_before_days'] * 86400
    if renew:
        command = [certbot, 'certonly', '--non-interactive', '--agree-tos',
                   '--register-unsafely-without-email', '--manual', '--preferred-challenges', 'dns',
                   '--manual-auth-hook', shlex.join([sys.executable, str(hook), 'auth']),
                   '--manual-cleanup-hook', shlex.join([sys.executable, str(hook), 'cleanup']),
                   '--config-dir', str(state / 'config'), '--work-dir', str(state / 'work'),
                   '--logs-dir', str(state / 'logs'), '--cert-name', config['cert_name'],
                   '--key-type', 'rsa', '--rsa-key-size', '2048', '--force-renewal']
        for domain in config['domains']:
            command += ['-d', domain]
        result = subprocess.run(command, env=env)
        if result.returncode:
            raise RuntimeError('Certificate issuance failed; ALB binding was not changed')
    decoded = ssl._ssl._test_decode_cert(str(cert_path))
    sans = {value for kind, value in decoded['subjectAltName'] if kind == 'DNS'}
    expires = ssl.cert_time_to_seconds(decoded['notAfter'])
    if not set(config['domains']).issubset(sans) or expires <= before['expires']:
        raise RuntimeError('New certificate coverage or validity is insufficient')
    cert_public = subprocess.check_output(['openssl', 'x509', '-in', str(cert_path), '-pubkey', '-noout'])
    key_public = subprocess.check_output(['openssl', 'pkey', '-in', str(key_path), '-pubout'], stderr=subprocess.PIPE)
    if cert_public.strip() != key_public.strip():
        raise RuntimeError('Certificate/private key do not match')
    pem = cert_path.read_text()
    leaf = pem[:pem.index('-----END CERTIFICATE-----') + len('-----END CERTIFICATE-----')]
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(leaf)).hexdigest()
    receipt = state / 'last-deployment.json'
    previous = json.loads(receipt.read_text()) if receipt.exists() else {}
    if previous.get('fingerprint') == fingerprint:
        new_id = previous['certificate_id']
    else:
        uploaded = cloud('cas', 'UploadUserCertificate', Name='junshi-alb-' + datetime.datetime.now().strftime('%Y%m%d%H%M%S'),
                         Cert=pem, Key=key_path.read_text())
        new_id = str(uploaded['CertId']) + '-' + uploaded.get('RegionId', config['region'])
    metadata = {'certificate_id': new_id, 'previous_certificate_id': old_id, 'fingerprint': fingerprint,
                'expires_utc': datetime.datetime.fromtimestamp(expires, datetime.timezone.utc).isoformat(), 'verified': False}
    receipt.write_text(json.dumps(metadata, indent=2) + '\n')
    receipt.chmod(0o600)
    current = cloud('alb', 'GetListenerAttribute', config['region'], ListenerId=config['listener_id'])
    if [row['CertificateId'] for row in current['Certificates']] != [old_id]:
        raise RuntimeError('Certificate binding changed during issuance; refusing to overwrite another operator')
    try:
        cloud('alb', 'UpdateListenerAttribute', config['region'], ListenerId=config['listener_id'],
              **{'Certificates.1.CertificateId': new_id})
        wait_for_binding(config, new_id, fingerprint)
    except Exception:
        current = cloud('alb', 'GetListenerAttribute', config['region'], ListenerId=config['listener_id'])
        if [row['CertificateId'] for row in current['Certificates']] not in [[new_id], [old_id]]:
            raise RuntimeError('Certificate binding changed by another operator; manual review required, no rollback overwrite')
        cloud('alb', 'UpdateListenerAttribute', config['region'], ListenerId=config['listener_id'],
              **{'Certificates.1.CertificateId': old_id})
        wait_for_binding(config, old_id, before['fingerprint'])
        raise RuntimeError('New binding verification failed; old certificate binding restored')
    metadata['verified'] = True
    receipt.write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
