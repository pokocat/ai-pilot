#!/usr/bin/env python3
"""Certbot DNS-01 hooks using the logged-in Alibaba CLI, without persistent AKs."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.parse
import urllib.request


def api(action, **args):
    command = [os.environ.get('ALIYUN_BIN', 'aliyun'), 'alidns', action]
    for key, value in args.items():
        command += ['--' + key, str(value)]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode:
        raise RuntimeError('Alibaba DNS API failed: ' + action)
    return json.loads(result.stdout)


def records(zone, rr):
    result = api('DescribeDomainRecords', DomainName=zone, RRKeyWord=rr, PageSize=500)
    return [r for r in result['DomainRecords']['Record'] if r['RR'] == rr]


def propagated(fqdn, validation):
    # Query authoritative servers, avoiding a workstation's fake-IP DNS cache.
    ns = subprocess.run(['dig', '+short', 'NS', os.environ['JUNSHI_CERT_ZONE']],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    names = [line.strip() for line in ns.stdout.splitlines() if line.strip().endswith('.')]
    if names:
        visible = []
        for server in names:
            r = subprocess.run(['dig', '+short', '+time=3', '+tries=1', 'TXT', fqdn, '@' + server],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            visible.append(r.returncode == 0 and validation in r.stdout)
        if all(visible):
            return True
    # HTTPS resolver also works behind developer VPNs that block outbound DNS.
    for endpoint in ['https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query']:
        try:
            url = endpoint + '?' + urllib.parse.urlencode({'name': fqdn, 'type': 'TXT'})
            request = urllib.request.Request(url, headers={'Accept': 'application/dns-json'})
            with urllib.request.urlopen(request, timeout=8) as response:
                result = json.load(response)
            if any(validation in row.get('data', '') for row in result.get('Answer', [])):
                return True
        except Exception:
            pass
    return False


def main():
    zone = os.environ['JUNSHI_CERT_ZONE']
    domain = os.environ['CERTBOT_DOMAIN'].removeprefix('*.')
    allowed = json.loads(os.environ['JUNSHI_CERT_DOMAINS'])
    if domain not in [d.removeprefix('*.') for d in allowed]:
        raise RuntimeError('Unexpected certificate domain')
    if domain != zone and not domain.endswith('.' + zone):
        raise RuntimeError('Challenge lies outside configured DNS zone')
    validation = os.environ['CERTBOT_VALIDATION']
    fqdn = '_acme-challenge.' + domain
    rr = fqdn[:-(len(zone) + 1)]
    state = pathlib.Path(os.environ['JUNSHI_CERT_STATE']) / 'challenges'
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    journal = state / (hashlib.sha256((domain + validation).encode()).hexdigest() + '.json')
    if sys.argv[1] == 'auth':
        if any(r['Type'] == 'CNAME' for r in records(zone, rr)):
            raise RuntimeError('Existing challenge CNAME delegation needs explicit configuration')
        if journal.exists():
            item = json.loads(journal.read_text())
        else:
            created = api('AddDomainRecord', DomainName=zone, RR=rr, Type='TXT', Value=validation, TTL=600)
            item = {'id': created['RecordId'], 'rr': rr, 'validation': validation}
            journal.write_text(json.dumps(item))
            journal.chmod(0o600)
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            if propagated(fqdn, validation):
                print(item['id'], flush=True)
                return
            time.sleep(5)
        raise RuntimeError('DNS propagation timeout; certificate was not deployed')
    elif sys.argv[1] == 'cleanup':
        if journal.exists():
            item = json.loads(journal.read_text())
            current = api('DescribeDomainRecordInfo', RecordId=item['id'])
            if (current['DomainName'], current['RR'], current['Type'], current['Value']) != (
                    zone, item['rr'], 'TXT', item['validation']):
                raise RuntimeError('Challenge record changed; refusing cleanup')
            api('DeleteDomainRecord', RecordId=item['id'])
            journal.unlink()
    else:
        raise RuntimeError('Expected auth or cleanup')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
