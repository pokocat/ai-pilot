#!/usr/bin/env python3
"""Scoped remote operations. Python 3.6 compatible for Alibaba Cloud Linux 3."""
import datetime
import hashlib
from html.parser import HTMLParser
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request


def execute(command, cwd=None, env=None, input=None, timeout=1800):
    result = subprocess.run(command, cwd=cwd, env=env, input=input, timeout=timeout,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if result.returncode:
        raise RuntimeError('Remote command failed: ' + pathlib.Path(command[0]).name)
    return result.stdout


def environment(path):
    path = pathlib.Path(path)
    if path.stat().st_mode & 0o077:
        raise RuntimeError('Environment file must be owner-only: ' + str(path))
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, value = line.split('=', 1)
        values[key] = json.loads(value) if value.startswith('"') else value
    return values


def validate_environment(config, component):
    values = environment(component['environment'])
    db = urllib.parse.urlsplit(values['DATABASE_URL'])
    redis = urllib.parse.urlsplit(values['REDIS_URL'])
    expected = config['database']
    if (db.hostname, db.path, db.username) != (expected['host'], '/' + expected['name'], expected['user']):
        raise RuntimeError('Production database identity mismatch')
    query = urllib.parse.parse_qs(db.query)
    if query.get('sslaccept') != ['strict'] or query.get('sslmode') != ['require']:
        raise RuntimeError('Strict database TLS is required')
    if (redis.scheme, redis.hostname, redis.path) != ('rediss', config['redis']['host'], '/' + config['redis']['database']):
        raise RuntimeError('Production Tair identity or TLS mismatch')
    if values.get('SCHEDULER_ENABLED') != 'false' or values.get('SERVICE_PROFILE') != component['profile']:
        raise RuntimeError('API profile/scheduler isolation mismatch')
    if values.get('NODE_ENV') != 'production':
        raise RuntimeError('Production environment is required')
    return values


def validate_test_values(config, values):
    url = urllib.parse.urlsplit(values['DATABASE_URL'])
    if values.get('NODE_ENV') != 'test' or url.path != '/' + config['test_database']:
        raise RuntimeError('Isolated test database was not configured')
    if url.path == '/' + config['database']['name'] or url.username == config['database']['user']:
        raise RuntimeError('Refusing tests with production database or application role')
    if url.hostname != config['database']['host']:
        raise RuntimeError('Test database host is not the configured RDS')


def service_state(component):
    output = execute(['systemctl', 'show', component['unit'], '-p', 'ActiveState', '-p', 'MainPID', '-p', 'WorkingDirectory'])
    return dict(line.split('=', 1) for line in output.splitlines() if '=' in line)


def health(component):
    try:
        with urllib.request.urlopen('http://127.0.0.1:' + str(component['port']) + '/api/health', timeout=8) as response:
            return response.status == 200 and json.load(response).get('db') == 'up'
    except Exception:
        return False


def inspect(config):
    result = {}
    for name, component in config['components'].items():
        validate_environment(config, component)
        state = service_state(component)
        version = pathlib.Path(component['root']) / '.deploy-version'
        result[name] = {'state': state['ActiveState'], 'healthy': health(component),
                        'directory': state['WorkingDirectory'],
                        'quiesce_supported': '[release] background workers draining' in
                            (pathlib.Path(state['WorkingDirectory']) / 'dist/index.js').read_text(),
                        'sha': version.read_text().strip() if version.exists() else None}
    return result


def check(config, expected=None, selected=None):
    result = inspect(config)
    for name, item in result.items():
        if item['state'] != 'active' or not item['healthy']:
            raise RuntimeError('Service is not healthy: ' + name)
        if expected and name in selected:
            component = config['components'][name]
            directory = str(pathlib.Path(component['root']) / 'releases' / expected / 'server')
            if item['sha'] != expected or item['directory'] != directory:
                raise RuntimeError('Loaded release mismatch: ' + name)
    return result


def run_log(command, directory, values, logfile):
    values = dict(os.environ, **values)
    values['PATH'] = str(pathlib.Path(CONFIG['node_binary']).parent) + ':' + values.get('PATH', '')
    values['PUPPETEER_SKIP_DOWNLOAD'] = 'true'
    values['CI'] = '1'
    with pathlib.Path(logfile).open('w') as output:
        os.chmod(str(logfile), 0o600)
        result = subprocess.run(command, cwd=str(directory), env=values, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError('Build/test failed; review protected log: ' + str(logfile))


def test_summary(path):
    data = pathlib.Path(path).read_text()
    def count(name):
        match = re.search(r'^ℹ ' + name + r' (\d+)\s*$', data, re.M)
        if not match:
            raise RuntimeError('Missing test summary: ' + str(path))
        return int(match.group(1))
    value = {name: count(name) for name in ['tests', 'pass', 'fail', 'skipped']}
    if value['pass'] <= 0 or value['fail'] != 0:
        raise RuntimeError('Test receipt is not passing')
    return value


def compiled_digest(server):
    digest = hashlib.sha256()
    for path in sorted((pathlib.Path(server) / 'dist').rglob('*')):
        if path.is_file():
            digest.update(str(path.relative_to(server)).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def safe_extract(archive, destination):
    with tarfile.open(str(archive), 'r:gz') as package:
        for member in package.getmembers():
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or member.issym() or member.islnk():
                raise RuntimeError('Archive contains unsafe member')
            if any(part.startswith('.env') and part not in ['.env.test', '.env.development'] and not part.endswith('.example') for part in name.parts):
                raise RuntimeError('Archive contains an environment file')
        package.extractall(str(destination))


def build(config, payload):
    root = pathlib.Path(config['runtime_root'])
    directory = root / 'builds' / payload['deployment_id']
    directory.mkdir(parents=True)
    source = pathlib.Path(payload['source_archive'])
    if hashlib.sha256(source.read_bytes()).hexdigest() != payload['source_sha256']:
        raise RuntimeError('Source archive checksum mismatch')
    safe_extract(source, directory)
    server = directory / 'server'
    node = config['node_binary']
    version = execute([node, '--version']).strip()
    if not version.startswith('v24.'):
        raise RuntimeError('Node 24 is required')
    memory = pathlib.Path('/proc/meminfo').read_text()
    if int(re.search(r'MemAvailable:\s*(\d+)', memory).group(1)) < 3 * 1024 * 1024:
        raise RuntimeError('Less than 3 GiB available on the inactive build node')
    test_values = environment(config['test_environment'])
    validate_test_values(config, test_values)
    for component in config['components'].values():
        if test_values['DATABASE_URL'] == environment(component['environment'])['DATABASE_URL']:
            raise RuntimeError('Test and production credentials must differ')
    test_file = server / '.env.test'
    shutil.copyfile(config['test_environment'], str(test_file))
    test_file.chmod(0o600)
    logs = root / 'logs' / payload['deployment_id']
    logs.mkdir(parents=True, mode=0o700)
    values = {'PATH': str(pathlib.Path(node).parent) + ':' + os.environ.get('PATH', '')}
    run_log(['npm', 'ci', '--include=dev'], server, values, logs / 'server-install.log')
    run_log([node, '--env-file=.env.test', 'node_modules/prisma/build/index.js', 'generate'], server,
            dict(values, NODE_ENV='test'), logs / 'prisma-generate.log')
    run_log(['npm', 'run', 'build'], server, values, logs / 'server-build.log')
    supplied = payload.get('validation_receipt')
    if supplied:
        if (supplied.get('server_tree') != payload['server_tree'] or supplied.get('node_version') != version
                or supplied.get('test_database') != config['test_database'] or supplied.get('status') != 'passed'):
            raise RuntimeError('Validation receipt does not match source/runtime/test database')
        for name in ['full', 'profile']:
            if supplied[name]['pass'] <= 0 or supplied[name]['fail'] != 0:
                raise RuntimeError('Validation receipt contains failures')
        tests = {name: supplied[name] for name in ['full', 'profile']}
    else:
        testing = dict(values, NODE_ENV='test')
        run_log(['npm', 'test'], server, testing, logs / 'server-tests.log')
        run_log(['npm', 'run', 'test:profile'], server, testing, logs / 'server-profile.log')
        tests = {'full': test_summary(logs / 'server-tests.log'), 'profile': test_summary(logs / 'server-profile.log')}
    test_file.unlink()
    shutil.copyfile(config['test_environment'], str(test_file))
    test_file.chmod(0o600)
    run_log([node, '--env-file=.env.test', str(directory / 'deploy/cluster/scheduler.mjs'), '--check'], server,
            dict(values, NODE_ENV='test', SCHEDULER_ENABLED='true', SERVICE_PROFILE='all'), logs / 'scheduler-registry.log')
    test_file.unlink()
    if payload['assets'].get('admin'):
        admin = directory / 'admin'
        run_log(['npm', 'ci', '--include=dev'], admin, values, logs / 'admin-install.log')
        run_log(['npm', 'test'], admin, values, logs / 'admin-tests.log')
        tests['admin'] = test_summary(logs / 'admin-tests.log')
        run_log(['npm', 'run', 'build', '--', '--base=/admin/'], admin, values, logs / 'admin-build.log')
    if payload['assets'].get('quickreel'):
        console = directory / 'quickreel-console'
        run_log(['npm', 'ci', '--include=dev'], console, values, logs / 'quickreel-console-install.log')
        run_log(['npm', 'run', 'build', '--', '--base=/quickreel/'], console, values, logs / 'quickreel-console-build.log')
    if payload['assets'].get('h5') or payload['assets'].get('pc'):
        app = directory / 'app'
        values.update(TARO_APP_MODE='server', TARO_APP_API='https://' + config['components']['junshi']['host'] + '/api')
        run_log(['npm', 'ci', '--include=dev'], app, values, logs / 'app-install.log')
        run_log(['npm', 'test'], app, values, logs / 'app-tests.log')
        if payload['assets'].get('h5'):
            run_log(['npm', 'run', 'build:h5:server'], app, values, logs / 'h5-build.log')
        if payload['assets'].get('pc'):
            raise RuntimeError('PC routing is not provisioned in this cluster; no traffic was changed')
    manifest = {'sha': payload['sha'], 'server_tree': payload['server_tree'], 'source_sha256': payload['source_sha256'],
                'node_version': version, 'compiled_digest': compiled_digest(server),
                'tests': tests, 'assets': payload['assets'], 'status': 'passed'}
    (directory / '.artifact-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    artifact = root / 'artifacts' / (payload['deployment_id'] + '.tar.gz')
    artifact.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(str(artifact), 'w:gz') as package:
        package.add(str(server), arcname='server')
        package.add(str(directory / 'deploy/cluster/scheduler.mjs'), arcname='ops/scheduler.mjs')
        package.add(str(directory / '.artifact-manifest.json'), arcname='.artifact-manifest.json')
        for name, source_dir in [('admin', 'admin/dist'), ('quickreel', 'quickreel-console/dist'), ('h5', 'app/dist-h5')]:
            if payload['assets'].get(name):
                package.add(str(directory / source_dir), arcname='assets/' + name)
    artifact.chmod(0o600)
    return {'artifact': str(artifact), 'sha256': hashlib.sha256(artifact.read_bytes()).hexdigest(), 'manifest': manifest}


def prepare(config, payload):
    archive = pathlib.Path(payload['artifact'])
    if hashlib.sha256(archive.read_bytes()).hexdigest() != payload['artifact_sha256']:
        raise RuntimeError('Artifact checksum mismatch')
    staging = pathlib.Path(config['runtime_root']) / 'unpacked' / payload['deployment_id']
    staging.mkdir(parents=True)
    # npm dependencies contain legitimate symlinks; only unpack our hash-verified built artifact.
    with tarfile.open(str(archive), 'r:gz') as package:
        for member in package.getmembers():
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts:
                raise RuntimeError('Unsafe artifact path')
            if member.issym() or member.islnk():
                link = pathlib.PurePosixPath(member.linkname)
                resolved = os.path.normpath(str(path.parent / link)) if member.issym() else str(link)
                if link.is_absolute() or resolved == '..' or resolved.startswith('../'):
                    raise RuntimeError('Unsafe artifact link')
        package.extractall(str(staging))
    manifest = json.loads((staging / '.artifact-manifest.json').read_text())
    if (manifest['sha'], manifest['source_sha256'], manifest['status']) != (payload['sha'], payload['source_sha256'], 'passed'):
        raise RuntimeError('Artifact provenance mismatch')
    for name in payload['selected']:
        component = config['components'][name]
        release = pathlib.Path(component['root']) / 'releases' / payload['sha']
        if release.exists():
            previous = json.loads((release / '.artifact-manifest.json').read_text())
            if any(previous[key] != manifest[key] for key in ['sha', 'server_tree', 'source_sha256', 'node_version', 'compiled_digest']):
                raise RuntimeError('Existing release has different provenance; refusing overwrite')
            if compiled_digest(release / 'server') != manifest['compiled_digest']:
                raise RuntimeError('Existing immutable release was modified; refusing to reuse')
        else:
            release.mkdir()
            shutil.copytree(str(staging / 'server'), str(release / 'server'), symlinks=True)
            shutil.copytree(str(staging / 'ops'), str(release / 'ops'))
            shutil.copyfile(str(staging / '.artifact-manifest.json'), str(release / '.artifact-manifest.json'))
        if (release / 'server/.env').exists() or (release / 'server/.env.test').exists():
            raise RuntimeError('Release must not contain an environment file')
    return {'prepared': payload['selected'], 'sha': payload['sha'], 'staging': str(staging)}


def metrics_in_flight(component):
    values = environment(component['environment'])
    request = urllib.request.Request('http://127.0.0.1:' + str(component['port']) + '/api/metrics',
                                     headers={'Authorization': 'Bearer ' + values['METRICS_TOKEN']})
    with urllib.request.urlopen(request, timeout=10) as response:
        text = response.read().decode()
    match = re.search(r'^junshi_http_in_flight (\d+(?:\.\d+)?)\s*$', text, re.M)
    if not match:
        raise RuntimeError('Missing in-flight metric; cannot prove connection drain')
    return int(float(match.group(1)))


def node_json(config, component, code):
    state = service_state(component)
    values = dict(os.environ, **environment(component['environment']))
    return json.loads(execute([config['node_binary'], '--input-type=module', '-e', code],
                             cwd=state['WorkingDirectory'], env=values).strip().splitlines()[-1])


def pending(config):
    component = config['components']['junshi']
    code = """import {prisma} from './dist/db.js';
try{const rows=await prisma.$queryRawUnsafe(`SELECT json_build_object(
'generation',(SELECT count(*) FROM generation_job WHERE status::text NOT IN ('completed','cancelled','truncated','failed')),
'creative',(SELECT count(*) FROM creative_job WHERE status NOT IN ('succeeded','failed','cancelled')),
'video',(SELECT count(*) FROM video_credit_hold WHERE status NOT IN ('settled','refunded')),
'clone',(SELECT count(*) FROM video_clone_hold WHERE status NOT IN ('settled','refunded')),
'effects_running',(SELECT count(*) FROM generation_effect WHERE status::text='running')) AS pending`);
console.log(JSON.stringify(rows[0].pending));}finally{await prisma.$disconnect();}"""
    return node_json(config, component, code)


def drain(config, payload):
    jobs = pending(config)
    if 'junshi' not in payload['selected']:
        jobs = {key: value for key, value in jobs.items() if key in ['video', 'clone']}
    return {'in_flight': {name: metrics_in_flight(config['components'][name]) for name in payload['selected']},
            'pending': jobs}


def quiesce(config, payload):
    result = {}
    for name in payload['selected']:
        component = config['components'][name]
        state = service_state(component)
        source = pathlib.Path(state['WorkingDirectory']) / 'dist/index.js'
        if '[release] background workers draining' not in source.read_text():
            if not payload.get('bootstrap_legacy_drain'):
                raise RuntimeError('Old process has no background-drain protocol; explicit migration bootstrap required')
            result[name] = 'legacy-bootstrap-observe-only'
            continue
        logfile = pathlib.Path(config['log_directory']) / (component['unit'] + '.log')
        position = logfile.stat().st_size
        execute(['systemctl', 'kill', '--kill-who=main', '--signal=SIGUSR2', component['unit']])
        deadline = time.monotonic() + 15
        acknowledged = False
        while time.monotonic() < deadline:
            if service_state(component)['MainPID'] != state['MainPID']:
                raise RuntimeError('Process changed while quiescing; refusing restart')
            with logfile.open() as stream:
                stream.seek(position)
                lines = stream.read().splitlines()
                position = stream.tell()
                for line in lines:
                    try:
                        entry = json.loads(line)
                        if str(entry.get('pid')) == state['MainPID'] and entry.get('releaseDrain') is True:
                            acknowledged = True
                    except ValueError:
                        pass
            if acknowledged:
                break
            time.sleep(0.2)
        if not acknowledged:
            raise RuntimeError('Background-drain signal was not acknowledged')
        result[name] = 'background-claims-stopped'
    return result


def switch_assets(config, payload, backups):
    staging = pathlib.Path(config['runtime_root']) / 'unpacked' / payload['deployment_id']
    for name, enabled in payload['assets'].items():
        if not enabled:
            continue
        source = staging / 'assets' / name
        target = pathlib.Path('/var/www/junshi') / name
        directory = pathlib.Path('/var/www/junshi/releases') / payload['deployment_id'] / name
        directory.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(str(source), str(directory))
        # Old clients may request hashed chunks after a traffic switch.
        for child in ['assets', 'fonts', 'static', 'js', 'css', 'img', 'images']:
            old = target / child
            if old.is_dir():
                for file in old.rglob('*'):
                    destination = directory / child / file.relative_to(old)
                    if file.is_file() and not destination.exists():
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(str(file), str(destination))
        if target.is_symlink():
            backups.append(('link', str(target), os.readlink(str(target))))
        elif target.is_dir():
            backup = pathlib.Path(config['runtime_root']) / 'backups' / payload['deployment_id'] / ('static-' + name)
            backup.parent.mkdir(parents=True, exist_ok=True)
            target.rename(backup)
            backups.append(('directory', str(target), str(backup)))
        else:
            raise RuntimeError('Unexpected current static root: ' + name)
        link = target.with_name('.' + name + '-' + payload['deployment_id'])
        link.symlink_to(directory)
        os.replace(str(link), str(target))


def local_http(host, path):
    request = urllib.request.Request('http://127.0.0.1' + path,
                                     headers={'Host': host, 'X-Forwarded-Proto': 'https'})
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.status, response.headers.get('Content-Type', ''), response.read()


class AssetReferences(HTMLParser):
    def __init__(self):
        HTMLParser.__init__(self)
        self.urls = []

    def handle_starttag(self, tag, attributes):
        for key, value in attributes:
            if value and ((tag == 'script' and key == 'src') or (tag == 'link' and key == 'href')):
                if urllib.parse.urlsplit(value).path.endswith(('.js', '.css')):
                    self.urls.append(value)


def static_check(config, payload):
    checks = []
    host = config['components']['junshi']['host']
    for name, enabled in payload['assets'].items():
        if not enabled:
            continue
        path = {'admin': '/admin/', 'quickreel': '/quickreel/', 'h5': '/'}[name]
        status, content_type, body = local_http(host, path)
        expected = (pathlib.Path('/var/www/junshi') / name / 'index.html').read_bytes()
        if status != 200 or 'text/html' not in content_type or body != expected:
            raise RuntimeError('Published static entry does not match the built release: ' + name)
        parser = AssetReferences()
        parser.feed(body.decode())
        if not parser.urls:
            raise RuntimeError('Static entry has no JavaScript/CSS references')
        for reference in parser.urls:
            url = urllib.parse.urlsplit(urllib.parse.urljoin('https://' + host + path, reference))
            if url.hostname != host:
                continue
            target = url.path + ('?' + url.query if url.query else '')
            code, kind, unused = local_http(host, target)
            if code != 200 or 'text/html' in kind:
                raise RuntimeError('Static JavaScript/CSS missing or routed to SPA HTML: ' + url.path)
            checks.append({'path': url.path, 'status': code})
        checks.append({'path': path, 'status': status, 'index_matches_release': True})
    return checks


def activate(config, payload):
    drained = drain(config, payload)
    if any(drained['in_flight'].values()) or any(drained['pending'].values()):
        raise RuntimeError('Node still has in-flight requests or unfinished work')
    backups = []
    selected = payload['selected']
    try:
        for name in selected:
            component = config['components'][name]
            release = pathlib.Path(component['root']) / 'releases' / payload['sha'] / 'server'
            if not (release / 'dist/index.js').is_file():
                raise RuntimeError('Release was not prepared')
            dropin = pathlib.Path('/etc/systemd/system') / (component['unit'] + '.service.d') / '20-cluster-release.conf'
            dropin.parent.mkdir(exist_ok=True)
            backups.append(('unit', str(dropin), dropin.read_text() if dropin.exists() else None))
            dropin.write_text('[Service]\nWorkingDirectory=' + str(release) + '\nExecStart=\nExecStart=' + config['node_binary'] + ' dist/index.js\n')
        switch_assets(config, payload, backups)
        execute(['systemctl', 'daemon-reload'])
        for name in selected:
            execute(['systemctl', 'restart', config['components'][name]['unit']], timeout=90)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if all(health(c) for c in config['components'].values()):
                break
            time.sleep(1)
        else:
            raise RuntimeError('New node did not become healthy')
        # Check the actual process environment, not just the environment file.
        for name in selected:
            component = config['components'][name]
            state = service_state(component)
            process_env = dict(entry.split('=', 1) for entry in
                               (pathlib.Path('/proc') / state['MainPID'] / 'environ').read_bytes().decode().split('\0') if '=' in entry)
            expected = environment(component['environment'])
            for key in ['DATABASE_URL', 'REDIS_URL', 'SCHEDULER_ENABLED', 'SERVICE_PROFILE']:
                if process_env.get(key) != expected.get(key):
                    raise RuntimeError('Loaded process configuration mismatch: ' + key)
            if state['WorkingDirectory'] != str(pathlib.Path(component['root']) / 'releases' / payload['sha'] / 'server'):
                raise RuntimeError('Loaded process directory mismatch')
        static_acceptance = static_check(config, payload)
    except Exception as error:
        for kind, target, previous in reversed(backups):
            path = pathlib.Path(target)
            if kind == 'unit':
                if previous is None:
                    path.unlink()
                else:
                    path.write_text(previous)
            elif kind == 'link':
                temporary = path.with_name('.rollback-' + path.name)
                temporary.symlink_to(previous)
                os.replace(str(temporary), str(path))
            elif kind == 'directory':
                if path.is_symlink():
                    path.unlink()
                pathlib.Path(previous).rename(path)
        execute(['systemctl', 'daemon-reload'])
        for name in selected:
            execute(['systemctl', 'restart', config['components'][name]['unit']], timeout=90)
        raise RuntimeError('Activation failed (' + str(error) + '); previous node configuration restored; traffic remains on other node')
    for name in selected:
        root = pathlib.Path(config['components'][name]['root'])
        (root / '.deploy-version').write_text(payload['sha'] + '\n')
        with (root / '.deploy-history').open('a') as history:
            history.write(datetime.datetime.utcnow().isoformat() + 'Z\t' + payload['sha'] + '\trolling healthy ' + payload['deployment_id'] + '\n')
    result = check(config, payload['sha'], selected)
    result['junshi']['static_checks'] = static_acceptance
    return result


def scheduler(config, payload):
    settings = config['scheduler']
    component = config['components']['junshi']
    release = pathlib.Path(component['root']) / 'releases' / payload['sha']
    values = environment(settings['environment'])
    if values.get('SCHEDULER_ENABLED') != 'true' or values.get('SERVICE_PROFILE') != 'all':
        raise RuntimeError('Dedicated scheduler configuration mismatch')
    primary = payload['node'] == settings['primary']
    if not primary and subprocess.call(['systemctl', 'is-active', '--quiet', settings['unit']]) == 0:
        raise RuntimeError('Standby scheduler is unexpectedly active; refusing to create duplicate jobs')
    dropin = pathlib.Path('/etc/systemd/system') / (settings['unit'] + '.service.d') / '20-cluster-release.conf'
    previous = dropin.read_text() if dropin.exists() else None
    dropin.parent.mkdir(exist_ok=True)
    try:
        # The new entry drains queued work; the first migration-era process uses its prior shutdown handler.
        if primary:
            execute(['systemctl', 'stop', settings['unit']], timeout=None)
        dropin.write_text('[Service]\nWorkingDirectory=' + str(release / 'server') + '\nExecStart=\nExecStart=' +
                          config['node_binary'] + ' ' + str(release / 'ops/scheduler.mjs') + '\nTimeoutStopSec=infinity\n')
        execute(['systemctl', 'daemon-reload'])
        if primary:
            execute(['systemctl', 'start', settings['unit']])
            time.sleep(2)
            execute(['systemctl', 'is-active', '--quiet', settings['unit']])
            execute(['systemctl', 'enable', settings['unit']])
        else:
            execute(['systemctl', 'disable', settings['unit']])
    except Exception:
        if previous is None:
            if dropin.exists():
                dropin.unlink()
        else:
            dropin.write_text(previous)
        execute(['systemctl', 'daemon-reload'])
        if primary:
            execute(['systemctl', 'start', settings['unit']])
        raise RuntimeError('Scheduler release failed; previous scheduler configuration restored')
    return {'scheduler': 'active' if primary else 'inactive', 'sha': payload['sha']}


def cache_probe(config, payload):
    operation, key = payload['operation'], 'deploy:shared-cache:' + payload['deployment_id']
    code = """import {cacheSet,cacheGet,cacheDel} from './dist/services/cache.js';
import {getRedis} from './dist/services/redis.js';
const key=KEY,operation=OPERATION;
try{if(operation==='write')await cacheSet(key,{probe:true},60000);
else if(operation==='read-delete'){const v=await cacheGet(key);if(!v?.probe)throw Error('Cache not shared');await cacheDel(key);}
else if(await cacheGet(key)!==null)throw Error('Cache delete not shared');
console.log(JSON.stringify({shared_cache:true,operation}));}
finally{const client=await getRedis();if(client)await client.quit();}""".replace('KEY', json.dumps(key)).replace('OPERATION', json.dumps(operation))
    return node_json(config, config['components']['junshi'], code)


def schema_check(config, payload):
    component = config['components'][payload['selected'][0]]
    root = pathlib.Path(config['runtime_root']) / 'builds' / payload['deployment_id'] / 'server'
    values = dict(os.environ, **environment(component['environment']))
    result = subprocess.run([config['node_binary'], 'node_modules/prisma/build/index.js', 'migrate', 'diff',
                             '--from-url', values['DATABASE_URL'], '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'],
                            cwd=str(root), env=values, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if result.returncode != 0:
        raise RuntimeError('Reviewed schema is not already present in RDS; no DDL or traffic change performed')
    return {'schema_matches_database': True}


def cleanup(config, payload):
    deployment = payload['deployment_id']
    if not re.match(r'^cluster-[0-9a-f]{8}-[0-9a-f]{12}$', deployment):
        raise RuntimeError('Unexpected deployment ID; refusing cleanup')
    root = pathlib.Path(config['runtime_root'])
    for path in [root / 'builds' / deployment, root / 'unpacked' / deployment]:
        if path.exists():
            shutil.rmtree(str(path))
    for path in [root / 'artifacts' / (deployment + '.tar.gz'),
                 root / 'incoming' / (deployment + '-source.tar.gz'),
                 root / 'incoming' / (deployment + '-artifact.tar.gz')]:
        if path.exists():
            path.unlink()
    return {'temporary_build_files_removed': True, 'releases_and_logs_preserved': True}


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        CONFIG = request['config']
        identity = json.loads(pathlib.Path(CONFIG['node_identity_file']).read_text())
        node = CONFIG['nodes'][request['node']]
        if identity != {'cluster_id': CONFIG['cluster_id'], 'instance_id': node['instance_id'], 'private_ip': node['private_ip']}:
            raise RuntimeError('Remote cluster identity mismatch; no operation performed')
        if node['host'] in ['8.136.36.175', '47.98.162.120']:
            raise RuntimeError('Legacy machine is forbidden')
        if 'sha' in request and not re.fullmatch(r'[0-9a-f]{40}', request['sha']):
            raise RuntimeError('Invalid release SHA')
        action = request['action']
        if action == 'inspect':
            result = inspect(CONFIG)
        elif action == 'verify':
            result = check(CONFIG, request.get('sha'), request.get('selected'))
        elif action == 'build':
            result = build(CONFIG, request)
        elif action == 'prepare':
            result = prepare(CONFIG, request)
        elif action == 'drain':
            result = drain(CONFIG, request)
        elif action == 'quiesce':
            result = quiesce(CONFIG, request)
        elif action == 'activate':
            result = activate(CONFIG, request)
        elif action == 'scheduler':
            result = scheduler(CONFIG, request)
        elif action == 'cache':
            result = cache_probe(CONFIG, request)
        elif action == 'schema':
            result = schema_check(CONFIG, request)
        elif action == 'cleanup':
            result = cleanup(CONFIG, request)
        elif action == 'static':
            result = static_check(CONFIG, request)
        else:
            raise RuntimeError('Unknown operation')
        print(json.dumps({'ok': True, 'result': result}))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
