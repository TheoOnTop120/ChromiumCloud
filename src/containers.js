'use strict';
const { execFileSync, execFile } = require('node:child_process');
const http = require('node:http');

const IMAGE = process.env.CHROMIUM_IMAGE || 'lscr.io/linuxserver/chromium:latest';
const NETWORK = process.env.DOCKER_NETWORK || 'nginx-proxy-manager_default';
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '10', 10);
const IDLE_STOP_MS = parseInt(process.env.IDLE_STOP_MS || String(30*60*1000), 10);
const lastActivity = new Map();

function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', ...opts });
}

function tryDocker(args, opts = {}) {
  try { return docker(args, opts); } catch (e) { return null; }
}

function containerName(userId) {
  return `chromium-u-${userId}`;
}

function volumeName(userId) {
  return `chromiumcloud_profile_${userId}`;
}

function listChromiumContainers() {
  try {
    const out = docker(['ps', '-a', '--filter', 'name=chromium-u-', '--format', '{{.Names}}\t{{.State}}']);
    const lines = out.trim().split('\n').filter(Boolean);
    return lines.map(l => {
      const [name, state] = l.split('\t');
      return { name, state };
    });
  } catch (e) {
    return [];
  }
}

function isRunning(userId) {
  const name = containerName(userId);
  try {
    const out = docker(['inspect', '-f', '{{.State.Running}}', name]).trim();
    return out === 'true';
  } catch (e) {
    return false;
  }
}

function exists(userId) {
  try {
    docker(['inspect', containerName(userId)]);
    return true;
  } catch (e) {
    return false;
  }
}

function activeCount() {
  return listChromiumContainers().filter(c => c.state === 'running').length;
}

function canStart(userId) {
  if (isRunning(userId)) return true;
  return activeCount() < MAX_SESSIONS;
}

function inspectState(userId) {
  try {
    return docker(['inspect', '-f', '{{.State.Status}}', containerName(userId)]).trim();
  } catch (e) {
    return 'absent';
  }
}

function inspectStartedAt(userId) {
  try {
    return docker(['inspect', '-f', '{{.State.StartedAt}}', containerName(userId)]).trim();
  } catch (e) {
    return null;
  }
}

function waitForReady(userId, timeoutMs = 90000) {
  const name = containerName(userId);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Démarrage du navigateur trop long.'));
        return;
      }
      const req = http.get(`http://${name}:3000/`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else setTimeout(poll, 1500);
      });
      req.on('error', () => setTimeout(poll, 1500));
      req.setTimeout(3000, () => { req.destroy(); setTimeout(poll, 1500); });
    };
    poll();
  });
}

async function startContainer(userId) {
  const name = containerName(userId);
  const vol = volumeName(userId);
  if (isRunning(userId)) {
    lastActivity.set(userId, Date.now());
    return name;
  }
  if (!canStart(userId)) {
    throw new Error('Limite de 10 sessions Chromium atteinte. Réessayez plus tard.');
  }
  if (exists(userId)) {
    docker(['start', name]);
    await waitForReady(userId);
    lastActivity.set(userId, Date.now());
    return name;
  }
  const args = [
    'run', '-d',
    '--name', name,
    '--network', NETWORK,
    '--restart', 'unless-stopped',
    '--security-opt', 'seccomp=unconfined',
    '--shm-size', '1g',
    '--memory', '1200m',
    '--cpus', '0.5',
    '-e', 'PUID=1000',
    '-e', 'PGID=1000',
    '-e', 'TZ=Europe/Brussels',
    '-e', 'LC_ALL=fr_FR.UTF-8',
    '-e', 'LANGUAGE=fr_FR:fr',
    '-e', 'CHROME_CLI=--lang=fr',
    '-v', `${vol}:/config`,
    IMAGE,
  ];
  docker(args);
  await waitForReady(userId);
  lastActivity.set(userId, Date.now());
  return name;
}

function stopContainer(userId) {
  const name = containerName(userId);
  try {
    docker(['stop', '-t', '15', name]);
  } catch (e) {}
}

function removeContainer(userId) {
  const name = containerName(userId);
  try { docker(['rm', '-f', name]); } catch (e) {}
}

function restartContainer(userId) {
  stopContainer(userId);
  // remove? keep volume. start again
  return startContainer(userId);
}

function touchActivity(userId) {
  lastActivity.set(userId, Date.now());
}

function getIdleStopped() {
  const now = Date.now();
  const stopped = [];
  for (const [userId, ts] of lastActivity.entries()) {
    if (now - ts > IDLE_STOP_MS && isRunning(userId)) {
      stopped.push(userId);
    }
  }
  return stopped;
}

function cleanupIdle() {
  for (const userId of getIdleStopped()) {
    stopContainer(userId);
  }
}

function userIdFromName(name) {
  const m = /^chromium-u-(\d+)$/.exec(name);
  return m ? parseInt(m[1], 10) : null;
}

function listUserSessions() {
  const containers = listChromiumContainers();
  return containers.map(c => {
    const uid = userIdFromName(c.name);
    return {
      userId: uid,
      name: c.name,
      state: c.state,
      running: c.state === 'running',
      startedAt: uid != null ? inspectStartedAt(uid) : null,
      idleMs: uid != null && lastActivity.has(uid) ? Date.now() - lastActivity.get(uid) : null,
    };
  });
}

function dockerStats() {
  try {
    const out = docker(['stats', '--no-stream', '--format', '{{json .}}']);
    const lines = out.trim().split('\n').filter(Boolean);
    const stats = {};
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        stats[j.Name] = {
          cpu: j.CPUPerc,
          memUsage: j.MemUsage,
          memPerc: j.MemPerc,
          pids: j.PIDs,
        };
      } catch {}
    }
    return stats;
  } catch (e) {
    return {};
  }
}

function userSessionStats() {
  const stats = dockerStats();
  const sessions = listUserSessions();
  return sessions.map(s => ({
    ...s,
    stats: stats[s.name] || null,
  }));
}

function systemStats() {
  let memTotal = 0, memAvailable = 0;
  try {
    const mt = tryDocker(['exec', 'chromium-gateway', 'cat', '/proc/meminfo']) ;
    // fallback read inside current container? We are in gateway already when running; but module runs in gateway.
  } catch {}
  // Read /proc directly (gateway runs in container with host proc)
  try {
    const fs = require('node:fs');
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const t = meminfo.match(/MemTotal:\s+(\d+)/); if (t) memTotal = parseInt(t[1],10)*1024;
    const a = meminfo.match(/MemAvailable:\s+(\d+)/); if (a) memAvailable = parseInt(a[1],10)*1024;
  } catch {}
  let loadavg = '';
  try {
    const fs = require('node:fs');
    loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim();
  } catch {}
  let uptime = 0;
  try {
    const fs = require('node:fs');
    const u = fs.readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/);
    uptime = parseFloat(u[0]);
  } catch {}
  let nproc = 1;
  try { nproc = parseInt(docker(['exec', 'chromium-gateway', 'nproc']), 10) || require('node:os').cpus().length; } catch { nproc = require('node:os').cpus().length; }
  return { memTotal, memAvailable, memUsed: memTotal - memAvailable, loadavg, uptime, nproc, cpuCount: require('node:os').cpus().length };
}

// periodic cleanup
setInterval(cleanupIdle, 5 * 60 * 1000);

module.exports = {
  containerName,
  volumeName,
  listChromiumContainers,
  isRunning,
  exists,
  activeCount,
  canStart,
  inspectState,
  inspectStartedAt,
  waitForReady,
  startContainer,
  stopContainer,
  removeContainer,
  restartContainer,
  touchActivity,
  MAX_SESSIONS,
  lastActivity,
  listUserSessions,
  userSessionStats,
  dockerStats,
  systemStats,
  userIdFromName,
};
