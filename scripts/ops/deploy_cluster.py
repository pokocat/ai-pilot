#!/usr/bin/env python3
"""Pinned-source, guarded active/standby rolling releases for the new ECS cluster."""
import argparse
import datetime
import hashlib
import http.client
import json
import os
import pathlib
import re
import select
import shlex
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
LEGACY_HOSTS = {'8.136.36.175', '47.98.162.120'}


def log(event, **data):
    print(json.dumps({'event': event, **data}, ensure_ascii=False), flush=True)


def command(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kwargs)
    if result.returncode:
        raise RuntimeError('Command failed: ' + pathlib.Path(args[0]).name)
    return result.stdout


def cloud(config, product, action, **args):
    cmd = [os.environ.get('ALIYUN_BIN', 'aliyun'), product, action, '--RegionId', config['region']]
    if product == 'alb':
        cmd += ['--force']
    for key, value in args.items():
        cmd += ['--' + key, str(value)]
    return json.loads(command(cmd))


def validate_config(config):
    if set(config['nodes']) != {'a', 'b'} or config['primary'] not in config['nodes']:
        raise RuntimeError('Expected an explicit two-node active/standby configuration')
    for node in config['nodes'].values():
        if node['host'] in LEGACY_HOSTS or not re.fullmatch(r'[0-9.]+', node['host']):
            raise RuntimeError('Legacy or non-literal deployment host is forbidden')
        if not re.fullmatch(r'i-[a-z0-9]+', node['instance_id']):
            raise RuntimeError('Invalid ECS instance identity')
    if len({n['instance_id'] for n in config['nodes'].values()}) != 2:
        raise RuntimeError('Primary and standby must be distinct ECS instances')
    if config['drain_seconds'] < 180 or config['drain_timeout_seconds'] <= config['drain_seconds']:
        raise RuntimeError('Drain budget must preserve the cluster connection-drain interval')
    if not re.fullmatch(r'/opt/[A-Za-z0-9_-]+', config['runtime_root']):
        raise RuntimeError('Unexpected remote build root')
    for component in config['components'].values():
        if not re.fullmatch(r'[a-z0-9-]+', component['unit']):
            raise RuntimeError('Invalid systemd unit name')
        if not re.fullmatch(r'/opt/[a-z0-9-]+', component['root']):
            raise RuntimeError('Invalid component release root')


def require_committed_tools():
    paths = [ROOT / 'scripts/deploy-prod.sh', ROOT / 'deploy/cluster/production.json',
             ROOT / 'deploy/cluster/scheduler.mjs'] + sorted((ROOT / 'scripts/ops').glob('*.py'))
    for path in paths:
        relative = str(path.relative_to(ROOT))
        try:
            recorded = command(['git', 'show', 'HEAD:' + relative], cwd=ROOT)
        except RuntimeError:
            raise RuntimeError('Commit the deployment tools before publishing: ' + relative)
        if recorded != path.read_text():
            raise RuntimeError('Deployment tool has uncommitted changes: ' + relative)


class Cluster:
    def __init__(self, config, run_dir, deployment_id, sha, selected, assets, bootstrap_legacy_drain=False):
        self.config, self.run_dir, self.deployment_id = config, run_dir, deployment_id
        self.sha, self.selected, self.assets = sha, selected, assets
        self.bootstrap_legacy_drain = bootstrap_legacy_drain
        self.transport = ['-i', os.environ.get('SSH_KEY', config['ssh_key']), '-o', 'BatchMode=yes',
                          '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=12']
        self.helper = (ROOT / 'scripts/ops/cluster_remote.py').read_text()
        self.lock = None
        self.state = {'deployment_id': deployment_id, 'sha': sha, 'selected': selected,
                      'tool_sha': command(['git', 'rev-parse', 'HEAD'], cwd=ROOT).strip(), 'events': []}

    def journal(self, event, **data):
        record = {'event': event, 'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), **data}
        self.state['events'].append(record)
        temporary = self.run_dir / 'state.tmp'
        temporary.write_text(json.dumps(self.state, indent=2, ensure_ascii=False) + '\n')
        temporary.chmod(0o600)
        os.replace(temporary, self.run_dir / 'state.json')
        log(event, **data)

    def address(self, node):
        return self.config['ssh_user'] + '@' + self.config['nodes'][node]['host']

    def remote(self, node, action, **payload):
        data = {'config': self.config, 'node': node, 'action': action, 'deployment_id': self.deployment_id,
                'selected': self.selected, 'assets': self.assets, **payload}
        script = 'import sys\nsys.argv=["cluster_remote.py"]\n' + self.helper
        # Code and payload travel over stdin; production credentials never leave the host.
        request = 'import io,sys\nsys.stdin=io.StringIO(' + repr(json.dumps(data)) + ')\n' + script
        attempts = 3 if action in ['inspect', 'verify', 'drain', 'static'] else 1
        for attempt in range(attempts):
            result = subprocess.run(['ssh', *self.transport, self.address(node), 'python3 -'], input=request,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                output = json.loads(result.stdout.strip().splitlines()[-1])
            except Exception:
                if attempt + 1 < attempts:
                    time.sleep(2)
                    continue
                raise RuntimeError('Remote operation returned no valid result: ' + node + '/' + action +
                                   '; exit=' + str(result.returncode) + '; inspect SSH and the release journal')
            if result.returncode or not output['ok']:
                raise RuntimeError(node + '/' + action + ': ' + output.get('error', 'SSH failed'))
            return output['result']

    def acquire_lock(self):
        node = self.config['primary']
        lock_path = '/run/lock/' + self.config['cluster_id'] + '-release.lock'
        cmd = 'flock -n ' + shlex.quote(lock_path) + ' sh -c ' + shlex.quote('echo LOCKED; cat >/dev/null')
        self.lock = subprocess.Popen(['ssh', *self.transport, self.address(node), cmd],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready, _, _ = select.select([self.lock.stdout], [], [], 15)
        if not ready or self.lock.stdout.readline().strip() != 'LOCKED':
            self.release_lock()
            raise RuntimeError('Another cluster release is running, or the lock host is unavailable')
        self.journal('release_lock_acquired')

    def release_lock(self):
        if self.lock:
            if self.lock.stdin:
                self.lock.stdin.close()
            try:
                self.lock.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.lock.terminate()
            self.lock = None

    def members(self):
        response = cloud(self.config, 'alb', 'ListServerGroupServers', ServerGroupId=self.config['server_group_id'])
        members = response['Servers']
        expected = {n['instance_id']: n for n in self.config['nodes'].values()}
        if {m['ServerId'] for m in members} != set(expected):
            raise RuntimeError('ALB backend membership differs from the configured cluster')
        for member in members:
            node = expected[member['ServerId']]
            if member['ServerIp'] != node['private_ip'] or member['Port'] != 80 or member['ServerType'] != 'Ecs':
                raise RuntimeError('ALB backend identity mismatch')
        return members

    def weights(self):
        members = self.members()
        if any(m['Status'] != 'Available' for m in members):
            raise RuntimeError('ALB backend configuration is still changing')
        return {code: next(m['Weight'] for m in members if m['ServerId'] == n['instance_id'])
                for code, n in self.config['nodes'].items()}

    def set_active(self, node):
        values = {}
        for index, (code, settings) in enumerate(self.config['nodes'].items(), 1):
            prefix = 'Servers.' + str(index) + '.'
            values.update({prefix + 'ServerId': settings['instance_id'], prefix + 'ServerType': 'Ecs',
                           prefix + 'Port': 80, prefix + 'Weight': 100 if code == node else 0})
        cloud(self.config, 'alb', 'UpdateServerGroupServersAttribute', ServerGroupId=self.config['server_group_id'], **values)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                current = self.weights()
                if current == {code: 100 if code == node else 0 for code in self.config['nodes']}:
                    self.journal('traffic_switched', active=node, weights=current)
                    return time.monotonic()
            except RuntimeError:
                pass
            time.sleep(2)
        raise RuntimeError('ALB weight update did not converge; inspect cloud state before continuing')

    def verify_cloud(self):
        ids = [node['instance_id'] for node in self.config['nodes'].values()]
        instances = cloud(self.config, 'ecs', 'DescribeInstances', InstanceIds=json.dumps(ids))['Instances']['Instance']
        if len(instances) != 2:
            raise RuntimeError('ECS identities could not be confirmed')
        for node in self.config['nodes'].values():
            instance = next(i for i in instances if i['InstanceId'] == node['instance_id'])
            public = instance['PublicIpAddress']['IpAddress']
            public += [instance['EipAddress']['IpAddress']] if instance.get('EipAddress', {}).get('IpAddress') else []
            if node['host'] not in public or node['private_ip'] not in instance['VpcAttributes']['PrivateIpAddress']['IpAddress']:
                raise RuntimeError('SSH IP does not belong to the expected ECS instance')
        group = next(g for g in cloud(self.config, 'alb', 'ListServerGroups')['ServerGroups']
                     if g['ServerGroupId'] == self.config['server_group_id'])
        drain = group.get('ConnectionDrainConfig', {})
        if self.config['load_balancer_id'] not in group.get('RelatedLoadBalancerIds', []):
            raise RuntimeError('Server group is attached to another ALB')
        if not drain.get('ConnectionDrainEnabled') or drain.get('ConnectionDrainTimeout', 0) > self.config['drain_seconds']:
            raise RuntimeError('ALB connection-drain configuration changed')
        return self.weights()

    def drain(self, node, since):
        self.journal('background_claims_quiescing', node=node)
        self.remote(node, 'quiesce', bootstrap_legacy_drain=self.bootstrap_legacy_drain)
        deadline = since + self.config['drain_timeout_seconds']
        stable = 0
        while time.monotonic() < deadline:
            current = self.weights()
            if current[node] != 0:
                raise RuntimeError('Cannot drain a node that still receives customer traffic')
            if time.monotonic() - since < self.config['drain_seconds']:
                time.sleep(min(5, self.config['drain_seconds'] - (time.monotonic() - since)))
                continue
            value = self.remote(node, 'drain')
            idle = not any(value['in_flight'].values()) and not any(value['pending'].values())
            stable = stable + 1 if idle else 0
            if stable >= 3:
                self.journal('node_drained', node=node, evidence=value)
                return
            time.sleep(2)
        raise RuntimeError('Drain timed out; old processes were kept running, no forced kill performed')

    def readiness(self, node):
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                for ip in self.config['verify_ips']:
                    for component in self.config['components'].values():
                        status, body = http_get(ip, component['host'], '/api/health/ready?backend=' + node)
                        if status != 200 or json.loads(body).get('db') != 'up':
                            raise RuntimeError('ALB readiness failed')
                self.journal('alb_readiness_passed', node=node)
                return
            except Exception:
                time.sleep(2)
        raise RuntimeError('ALB readiness did not converge for node ' + node)

    def shared_cache(self, standby, primary):
        self.remote(standby, 'cache', operation='write')
        self.remote(primary, 'cache', operation='read-delete')
        self.remote(standby, 'cache', operation='absent')
        self.journal('tair_cross_node_verified')

    def activate(self, node):
        result = self.remote(node, 'activate', sha=self.sha)
        self.journal('node_activated', node=node, services=result)
        self.readiness(node)

    def verify(self, node):
        return self.remote(node, 'verify', sha=self.sha, selected=self.selected)

    def recover(self):
        for node in [self.config['primary']] + [n for n in self.config['nodes'] if n != self.config['primary']]:
            try:
                # Recovery may serve the previous release; database identity must stay new RDS.
                self.remote(node, 'verify')
                self.readiness(node)
                self.set_active(node)
                self.journal('failure_recovered_to_healthy_node', active=node)
                return
            except Exception:
                continue
        self.journal('manual_recovery_required', note='Neither node passed verification; existing cloud state retained')


def http_get(ip, host, path):
    connection = socket.create_connection((ip, 443), timeout=15)
    tls = ssl.create_default_context().wrap_socket(connection, server_hostname=host)
    client = http.client.HTTPConnection(host, timeout=15)
    client.sock = tls
    try:
        client.request('GET', path, headers={'Host': host})
        response = client.getresponse()
        return response.status, response.read()
    finally:
        client.close()


def rolling_release(cluster, active, build_and_prepare):
    standby = next(n for n in cluster.config['nodes'] if n != active)
    changed = False
    try:
        changed = True
        started = cluster.set_active(active)
        build_and_prepare(standby)
        cluster.drain(standby, started)
        cluster.activate(standby)
        cluster.verify(standby)
        cluster.shared_cache(standby, active)
        switched = cluster.set_active(standby)
        cluster.drain(active, switched)
        cluster.activate(active)
        cluster.verify(active)
        if 'junshi' in cluster.selected:
            # API releases and the dedicated scheduler share code, but only one scheduler may run.
            secondary = next(n for n in cluster.config['nodes'] if n != cluster.config['scheduler']['primary'])
            cluster.remote(secondary, 'scheduler', sha=cluster.sha)
            cluster.remote(cluster.config['scheduler']['primary'], 'scheduler', sha=cluster.sha)
            cluster.journal('dedicated_scheduler_updated')
        cluster.set_active(cluster.config['primary'])
        for node in cluster.config['nodes']:
            cluster.verify(node)
            cluster.readiness(node)
        cluster.journal('completed', active=cluster.config['primary'], standby_running=True)
    except Exception:
        if changed:
            cluster.recover()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=pathlib.Path, default=ROOT / 'deploy/cluster/production.json')
    parser.add_argument('--sha', default=os.environ.get('DEPLOY_SHA', 'HEAD'))
    parser.add_argument('--component', choices=['junshi', 'quickreel', 'both'], default='quickreel' if os.environ.get('QUICKREEL_ONLY') == '1' else 'junshi')
    parser.add_argument('--skip-admin', action='store_true', default=os.environ.get('SKIP_ADMIN') == '1')
    parser.add_argument('--h5', action='store_true', default=os.environ.get('DEPLOY_H5') == '1')
    parser.add_argument('--plan', action='store_true', help='Read-only identity, schema and routing inspection')
    parser.add_argument('--schema-reviewed', action='store_true', help='Allow a reviewed schema change only if RDS already matches it; never applies DDL')
    parser.add_argument('--validation-receipt', type=pathlib.Path, help='Reuse a passing PG18 receipt for the identical server Git tree and Node version')
    parser.add_argument('--bootstrap-legacy-drain', action='store_true', help='One-time migration of old processes without drain signals; requires the normal zero-work checks')
    args = parser.parse_args()
    if not args.plan:
        require_committed_tools()
        command([sys.executable, '-m', 'unittest', 'discover', '-s', str(ROOT / 'scripts/ops'), '-p', 'test_*.py'], cwd=ROOT)
    for name in ['DEPLOY_HOST', 'REMOTE_ROOT', 'PUBLIC_BASE']:
        if os.environ.get(name):
            raise RuntimeError(name + ' is a retired single-host setting; use the checked cluster configuration')
    if os.environ.get('ACCEPT_DATA_LOSS') == '1' or os.environ.get('DEPLOY_PC') == '1':
        raise RuntimeError('Destructive schema push and unprovisioned PC deployment are forbidden')
    config = json.loads(args.config.read_text())
    validate_config(config)
    sha = command(['git', 'rev-parse', args.sha + '^{commit}'], cwd=ROOT).strip()
    selected = ['junshi', 'quickreel'] if args.component == 'both' else [args.component]
    assets = {'admin': args.component != 'quickreel' and not args.skip_admin,
              'quickreel': args.component != 'quickreel' and not args.skip_admin, 'h5': args.h5}
    if args.component == 'quickreel' and args.h5:
        raise RuntimeError('Quickreel-only releases cannot replace Junshi H5')
    run_dir = ROOT / '.deploy-logs' / ('cluster-' + sha[:8] + '-' + uuid.uuid4().hex[:12])
    run_dir.mkdir(parents=True, mode=0o700)
    deployment_id = run_dir.name
    cluster = Cluster(config, run_dir, deployment_id, sha, selected, assets, args.bootstrap_legacy_drain)
    try:
        cluster.acquire_lock()
        weights = cluster.verify_cloud()
        active_nodes = [node for node, weight in weights.items() if weight == 100]
        if len(active_nodes) != 1 or sum(weights.values()) != 100:
            raise RuntimeError('Expected one active backend and one zero-weight standby')
        active = active_nodes[0]
        baseline = {node: cluster.remote(node, 'inspect') for node in config['nodes']}
        if any(not item['healthy'] for item in baseline[active].values()):
            raise RuntimeError('Current active backend is unhealthy; use the incident recovery SOP first')
        schema_changed = False
        for node in baseline.values():
            for component in selected:
                previous = node[component]['sha']
                if not previous or not re.fullmatch(r'[0-9a-f]{40}', previous):
                    raise RuntimeError('Previous release SHA is unknown')
                differences = command(['git', 'diff', '--name-only', previous, sha, '--', 'server/prisma/schema.prisma', 'server/prisma/pgvector.sql'], cwd=ROOT)
                schema_changed = schema_changed or bool(differences.strip())
        cluster.journal('preflight_passed', active=active, baseline=baseline, schema_changed=schema_changed, assets=assets)
        if args.plan:
            log('read_only_plan', sha=sha, selected=selected, schema_change_requires_review=schema_changed,
                order=['build and test inactive node', 'verify standby', 'switch traffic', 'drain old node',
                       'update old node', 'single scheduler release', 'restore primary 100 / standby 0'])
            return
        if any(not node[name]['quiesce_supported'] for node in baseline.values() for name in selected) and not args.bootstrap_legacy_drain:
            raise RuntimeError('Legacy processes need the one-time --bootstrap-legacy-drain migration; normal releases require drain support')
        entry_source = command(['git', 'show', sha + ':server/src/index.ts'], cwd=ROOT)
        if '[release] background workers draining' not in entry_source:
            raise RuntimeError('Target release does not support safe background draining')
        scheduler_source = command(['git', 'show', sha + ':deploy/cluster/scheduler.mjs'], cwd=ROOT)
        if "process.argv.includes('--check')" not in scheduler_source:
            raise RuntimeError('Target scheduler entry does not support registry validation')
        if schema_changed and not args.schema_reviewed:
            raise RuntimeError('Schema changed; complete the expand/contract migration SOP before using --schema-reviewed')
        archive = run_dir / 'source.tar.gz'
        command(['git', 'archive', '--format=tar.gz', '--output=' + str(archive), sha], cwd=ROOT)
        source_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
        server_tree = command(['git', 'rev-parse', sha + ':server'], cwd=ROOT).strip()
        receipt = json.loads(args.validation_receipt.read_text()) if args.validation_receipt else None
        remote_archive = config['runtime_root'] + '/incoming/' + deployment_id + '-source.tar.gz'

        def build_and_prepare(standby):
            command(['ssh', *cluster.transport, cluster.address(standby),
                     'mkdir -p ' + shlex.quote(config['runtime_root'] + '/incoming')])
            command(['scp', *cluster.transport, str(archive), cluster.address(standby) + ':' + remote_archive])
            built = cluster.remote(standby, 'build', sha=sha, source_archive=remote_archive,
                                   source_sha256=source_hash, server_tree=server_tree, validation_receipt=receipt)
            cluster.journal('artifact_validated', build_node=standby, **built)
            if schema_changed:
                cluster.remote(standby, 'schema', sha=sha)
            local_artifact = run_dir / 'artifact.tar.gz'
            command(['scp', *cluster.transport, cluster.address(standby) + ':' + built['artifact'], str(local_artifact)])
            if hashlib.sha256(local_artifact.read_bytes()).hexdigest() != built['sha256']:
                raise RuntimeError('Downloaded artifact checksum mismatch')
            for node in config['nodes']:
                if node == standby:
                    cluster.remote(node, 'prepare', sha=sha, artifact=built['artifact'],
                                   artifact_sha256=built['sha256'], source_sha256=source_hash)
                    continue
                remote_artifact = config['runtime_root'] + '/incoming/' + deployment_id + '-artifact.tar.gz'
                command(['ssh', *cluster.transport, cluster.address(node),
                         'mkdir -p ' + shlex.quote(config['runtime_root'] + '/incoming')])
                command(['scp', *cluster.transport, str(local_artifact), cluster.address(node) + ':' + remote_artifact])
                cluster.remote(node, 'prepare', sha=sha, artifact=remote_artifact,
                               artifact_sha256=built['sha256'], source_sha256=source_hash)
            # The same verified bytes are used on both machines; no live-directory build occurs.
            archive.unlink()
            local_artifact.unlink()
        rolling_release(cluster, active, build_and_prepare)
        for node in config['nodes']:
            cluster.remote(node, 'cleanup')
        cluster.journal('temporary_artifacts_cleaned', releases_and_logs_preserved=True)
        print('Release receipt: ' + str(run_dir / 'state.json'), flush=True)
    finally:
        cluster.release_lock()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
