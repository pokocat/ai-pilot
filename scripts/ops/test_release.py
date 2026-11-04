import copy
import importlib.util
import io
import json
import os
import pathlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deploy = load('deploy_cluster')
remote = load('cluster_remote')
dns = load('certificate_dns')
renew = load('renew_alb_certificate')
CONFIG = json.loads((ROOT / 'deploy/cluster/production.json').read_text())


class FakeCluster:
    def __init__(self, failing=None, active='a', selected=None):
        self.config = CONFIG
        self.sha = 'f' * 40
        self.selected = selected or ['junshi', 'quickreel']
        self.active = active
        self.updated = set()
        self.healthy = {'a': True, 'b': True}
        self.events = []
        self.failing = failing

    def event(self, name, node=None):
        self.events.append((name, node))
        if (name, node) == self.failing:
            raise RuntimeError('injected failure')

    def journal(self, event, **data):
        self.event(event)

    def set_active(self, node):
        if not self.healthy[node]:
            raise AssertionError('Traffic must never target an unhealthy node')
        self.event('switch', node)
        self.active = node
        return 0

    def drain(self, node, since):
        if self.active == node:
            raise AssertionError('Cannot drain the active node')
        self.event('drain', node)

    def activate(self, node):
        if self.active == node:
            raise AssertionError('Cannot update the active node')
        self.healthy[node] = False
        self.event('activate', node)
        self.updated.add(node)
        self.healthy[node] = True

    def verify(self, node):
        self.event('verify', node)
        if not self.healthy[node] or node not in self.updated:
            raise RuntimeError('not verified')

    def shared_cache(self, standby, primary):
        self.event('shared-cache')

    def remote(self, node, action, **kwargs):
        self.event(action, node)

    def readiness(self, node):
        if not self.healthy[node]:
            raise RuntimeError('not ready')

    def recover(self):
        for node in ['a', 'b']:
            if self.healthy[node]:
                self.active = node
                self.event('recovered', node)
                return


class RollingTests(unittest.TestCase):
    def release(self, cluster, build=None):
        deploy.rolling_release(cluster, cluster.active, build or (lambda node: cluster.event('built', node)))

    def test_both_nodes_are_updated_without_updating_the_active_one(self):
        cluster = FakeCluster()
        self.release(cluster)
        events = cluster.events
        self.assertLess(events.index(('built', 'b')), events.index(('activate', 'b')))
        self.assertLess(events.index(('verify', 'b')), events.index(('switch', 'b')))
        self.assertLess(events.index(('drain', 'a')), events.index(('activate', 'a')))
        self.assertEqual(cluster.updated, {'a', 'b'})
        self.assertEqual(cluster.active, 'a')
        self.assertIn(('scheduler', 'a'), events)
        self.assertIn(('scheduler', 'b'), events)

    def test_a_failed_standby_never_receives_customer_traffic(self):
        cluster = FakeCluster(('activate', 'b'))
        with self.assertRaises(RuntimeError):
            self.release(cluster)
        self.assertEqual(cluster.active, 'a')
        self.assertNotIn(('switch', 'b'), cluster.events)
        self.assertNotIn(('activate', 'a'), cluster.events)

    def test_failure_updating_old_primary_keeps_new_standby_serving(self):
        cluster = FakeCluster(('activate', 'a'))
        with self.assertRaises(RuntimeError):
            self.release(cluster)
        self.assertEqual(cluster.active, 'b')
        self.assertTrue(cluster.healthy['b'])
        self.assertNotIn(('scheduler', 'a'), cluster.events)

    def test_build_failure_never_restarts_either_node(self):
        cluster = FakeCluster(('built', 'b'))
        with self.assertRaises(RuntimeError):
            self.release(cluster)
        self.assertEqual(cluster.active, 'a')
        self.assertFalse(cluster.updated)

    def test_unfinished_work_blocks_restart_of_original_primary(self):
        cluster = FakeCluster(('drain', 'a'))
        with self.assertRaises(RuntimeError):
            self.release(cluster)
        self.assertNotIn(('activate', 'a'), cluster.events)
        self.assertTrue(cluster.healthy['a'])

    def test_can_start_with_b_serving_and_restore_a_as_primary(self):
        cluster = FakeCluster(active='b')
        self.release(cluster)
        self.assertIn(('built', 'a'), cluster.events)
        self.assertEqual(cluster.active, 'a')

    def test_quickreel_only_does_not_restart_scheduler(self):
        cluster = FakeCluster(selected=['quickreel'])
        self.release(cluster)
        self.assertFalse(any(event == 'scheduler' for event, _ in cluster.events))


class GuardTests(unittest.TestCase):
    def test_quickreel_quiesce_does_not_stop_military_workers(self):
        with tempfile.TemporaryDirectory() as directory:
            config = copy.deepcopy(CONFIG)
            config['log_directory'] = directory
            source = pathlib.Path(directory) / 'dist'
            source.mkdir()
            (source / 'index.js').write_text('[release] background workers draining')
            logfile = pathlib.Path(directory) / 'junshi-quickreel.log'
            logfile.write_text('')
            commands = []
            def execute(command, **kwargs):
                commands.append(command)
                with logfile.open('a') as stream:
                    stream.write(json.dumps({'pid': 42, 'releaseDrain': True}) + '\n')
                return ''
            with patch.object(remote, 'service_state', return_value={'MainPID': '42', 'WorkingDirectory': directory}), \
                    patch.object(remote, 'execute', side_effect=execute):
                result = remote.quiesce(config, {'selected': ['quickreel']})
            self.assertEqual(result, {'quickreel': 'background-claims-stopped'})
            self.assertEqual(commands, [['systemctl', 'kill', '--kill-who=main', '--signal=SIGUSR2', 'junshi-quickreel']])

    def test_old_process_without_protocol_never_receives_a_terminating_signal(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / 'dist'
            source.mkdir()
            (source / 'index.js').write_text('legacy process')
            with patch.object(remote, 'service_state', return_value={'MainPID': '42', 'WorkingDirectory': directory}), \
                    patch.object(remote, 'execute') as execute:
                with self.assertRaisesRegex(RuntimeError, 'bootstrap'):
                    remote.quiesce(CONFIG, {'selected': ['junshi']})
                execute.assert_not_called()

    def test_legacy_hosts_rejected_before_transport(self):
        for host in ['8.136.36.175', '47.98.162.120']:
            config = copy.deepcopy(CONFIG)
            config['nodes']['b']['host'] = host
            with self.assertRaisesRegex(RuntimeError, 'Legacy'):
                deploy.validate_config(config)

    def test_accidental_short_drain_budget_is_rejected(self):
        config = copy.deepcopy(CONFIG)
        config['drain_seconds'] = 5
        with self.assertRaises(RuntimeError):
            deploy.validate_config(config)

    def test_production_database_or_role_cannot_be_used_for_tests(self):
        expected = CONFIG['database']
        for url in ['postgresql://test:x@' + expected['host'] + '/' + expected['name'],
                    'postgresql://' + expected['user'] + ':x@' + expected['host'] + '/' + CONFIG['test_database']]:
            with self.assertRaises(RuntimeError):
                remote.validate_test_values(CONFIG, {'NODE_ENV': 'test', 'DATABASE_URL': url})
        remote.validate_test_values(CONFIG, {'NODE_ENV': 'test', 'DATABASE_URL':
            'postgresql://isolated_test:x@' + expected['host'] + '/' + CONFIG['test_database']})

    def test_world_readable_environment_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'environment'
            path.write_text('NODE_ENV="production"\n')
            path.chmod(0o644)
            with self.assertRaises(RuntimeError):
                remote.environment(path)

    def test_source_archive_cannot_escape_or_load_production_env(self):
        for name in ['../escape', '/escape', 'server/.env']:
            with tempfile.TemporaryDirectory() as directory:
                path = pathlib.Path(directory)
                with tarfile.open(path / 'source.tar.gz', 'w:gz') as archive:
                    info = tarfile.TarInfo(name)
                    info.size = 1
                    archive.addfile(info, io.BytesIO(b'x'))
                with self.assertRaises(RuntimeError):
                    remote.safe_extract(path / 'source.tar.gz', path / 'out')

    def test_cleanup_preserves_releases_and_other_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            run = 'cluster-12345678-123456789abc'
            for name in ['builds/' + run, 'builds/another-run', 'releases/previous']:
                (root / name).mkdir(parents=True)
            remote.cleanup({'runtime_root': directory}, {'deployment_id': run})
            self.assertFalse((root / 'builds' / run).exists())
            self.assertTrue((root / 'builds/another-run').exists())
            self.assertTrue((root / 'releases/previous').exists())
            with self.assertRaises(RuntimeError):
                remote.cleanup({'runtime_root': directory}, {'deployment_id': '../another-run'})


class CertificateTests(unittest.TestCase):
    def test_dns_cleanup_will_not_delete_a_record_that_someone_changed(self):
        with tempfile.TemporaryDirectory() as directory:
            domain, validation = 'wxapi.aibuzz.cn', 'public-validation-value'
            env = {'JUNSHI_CERT_ZONE': 'aibuzz.cn', 'JUNSHI_CERT_DOMAINS': json.dumps([domain]),
                   'JUNSHI_CERT_STATE': directory, 'CERTBOT_DOMAIN': domain, 'CERTBOT_VALIDATION': validation}
            state = pathlib.Path(directory) / 'challenges'
            state.mkdir()
            file = state / (dns.hashlib.sha256((domain + validation).encode()).hexdigest() + '.json')
            file.write_text(json.dumps({'id': 'owned-record', 'rr': '_acme-challenge.wxapi', 'validation': validation}))
            with patch.dict(os.environ, env), patch.object(dns.sys, 'argv', ['hook', 'cleanup']), patch.object(dns, 'api') as api:
                api.return_value = {'DomainName': 'aibuzz.cn', 'RR': '_acme-challenge.wxapi', 'Type': 'TXT', 'Value': 'changed'}
                with self.assertRaises(RuntimeError):
                    dns.main()
                self.assertEqual(api.call_count, 1)
                self.assertTrue(file.exists())

    def test_failed_new_certificate_verification_restores_old_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            state = root / 'state'
            live = state / 'config/live/test'
            live.mkdir(parents=True)
            (live / 'fullchain.pem').write_text('-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n')
            (live / 'privkey.pem').write_text('fake-private-key')
            config = {'region': 'cn-hangzhou', 'listener_id': 'listener', 'load_balancer_id': 'alb', 'cert_name': 'test',
                      'dns_zone': 'aibuzz.cn', 'domains': ['wxapi.aibuzz.cn'], 'renew_before_days': 35,
                      'verify_ips': ['127.0.0.1'], 'verify_hosts': ['wxapi.aibuzz.cn']}
            (root / 'config.json').write_text(json.dumps(config))
            old = {'expires': renew.time.time() + 86400, 'fingerprint': 'old-fingerprint', 'sans': config['domains']}
            calls = []
            def cloud(product, action, region=None, **kwargs):
                calls.append((action, kwargs))
                if action == 'GetListenerAttribute':
                    return {'LoadBalancerId': 'alb', 'ListenerPort': 443, 'Certificates': [{'CertificateId': 'old'}]}
                if action == 'UploadUserCertificate':
                    return {'CertId': 123, 'RegionId': 'cn-hangzhou'}
                return {}
            argv = ['renew', '--config', str(root / 'config.json'), '--state-dir', str(state)]
            decoded = {'notAfter': 'Feb  2 00:00:00 2030 GMT', 'subjectAltName': [('DNS', 'wxapi.aibuzz.cn')]}
            with patch.object(renew.sys, 'argv', argv), patch.object(renew, 'peer', return_value=old), \
                    patch.object(renew, 'cloud', side_effect=cloud), patch.object(renew.shutil, 'which', return_value='/certbot'), \
                    patch.object(renew.ssl._ssl, '_test_decode_cert', return_value=decoded), \
                    patch.object(renew.ssl, 'PEM_cert_to_DER_cert', return_value=b'der'), \
                    patch.object(renew.subprocess, 'check_output', return_value=b'PUBLIC'), \
                    patch.object(renew, 'wait_for_binding', side_effect=[RuntimeError('failed VIP'), None]):
                with self.assertRaisesRegex(RuntimeError, 'restored'):
                    renew.main()
            changes = [kwargs['Certificates.1.CertificateId'] for action, kwargs in calls if action == 'UpdateListenerAttribute']
            self.assertEqual(changes, ['123-cn-hangzhou', 'old'])


if __name__ == '__main__':
    unittest.main()
