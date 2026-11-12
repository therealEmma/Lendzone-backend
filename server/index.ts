import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Server, Socket } from 'socket.io';
import {
  GameSnapshot, HostActionPayload, InputCommand, JoinPayload, KillFeedItem, LeaderboardEntry,
  PLATFORM_LAYOUT, PlayerSnapshot, ScoreLine, SessionPayload, WORLD, MatchPhase,
} from '../shared/types.js';
import { addDamage, addDeath, addKill, applyDamage, isRespawnDue, remainingMatchMs } from '../shared/rules.js';
import { circleHitsPlayer, PLAYER_SPAWNS, resetPhysicsPlayer, segmentHitsPlatform, stepPlayer } from './physics.js';

const PORT = Number(process.env.PORT ?? 3000);
const configuredCapacity = Number(process.env.MAX_PLAYERS ?? 30);
const DEFAULT_CAPACITY = Number.isFinite(configuredCapacity) ? Math.min(30, Math.max(2, configuredCapacity)) : 30;
const MIN_PLAYERS_TO_START = 2;
const DEFAULT_DURATION = Math.max(30, Number(process.env.MATCH_DURATION_SECONDS ?? 300));
const configuredReconnectGraceSeconds = Number(process.env.RECONNECT_GRACE_SECONDS ?? 120);
const RECONNECT_GRACE_MS = (Number.isFinite(configuredReconnectGraceSeconds) ? Math.max(1, configuredReconnectGraceSeconds) : 120) * 1000;
const HOST_SECRET = process.env.HOST_SECRET?.trim() ?? '';
const configuredCorsOrigins = (process.env.CORS_ORIGIN ?? '').split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean);
const allowAllOrigins = configuredCorsOrigins.length === 0 || configuredCorsOrigins.includes('*');
const corsOrigin = (origin: string | undefined, callback: (error: Error | null, origin?: boolean) => void): void => {
  if (!origin || allowAllOrigins || configuredCorsOrigins.includes(origin)) callback(null, true);
  else callback(new Error(`CORS origin rejected: ${origin}`));
};
const ROOM_ID = process.env.ROOM_ID?.trim() || 'lendzone-main';
const INSTANCE_ID = process.env.RAILWAY_REPLICA_ID || process.env.RAILWAY_INSTANCE_ID || randomUUID().slice(0, 8);
const DEBUG_COMBAT = process.env.DEBUG_COMBAT === '1';

interface ServerPlayer {
  id: string;
  socketId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  fuel: number;
  jetpacking: boolean;
  aimAngle: number;
  hp: number;
  ammo: number;
  alive: boolean;
  respawnAt: number | null;
  spawnProtectedUntil: number;
  reloadEndsAt: number | null;
  nextShotAt: number;
  input: InputCommand;
  lastInputSeq: number;
  score: ScoreLine;
  joinedAt: number;
}

interface TokenRecord {
  playerId: string;
  expiresAt: number;
}

interface Projectile {
  id: number;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
}

const app = express();
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true, service: 'lendzone', roomId: ROOM_ID, instanceId: INSTANCE_ID, phase: room.phase, players: room.players.size, disconnected: room.disconnected.size, occupancy: roomOccupancy(), capacity: room.capacity, reconnectGraceSeconds: RECONNECT_GRACE_MS / 1000, socketPath: '/socket.io' }));
app.get('/', (_req, res) => res.json({ ok: true, service: 'lendzone', message: 'Backend is running. Open the public frontend URL.' }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: corsOrigin, credentials: true },
  pingInterval: 10_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 30_000,
});

const room = {
  phase: 'LOBBY' as MatchPhase,
  paused: false,
  durationSeconds: DEFAULT_DURATION,
  capacity: DEFAULT_CAPACITY,
  countdownEndsAt: 0,
  matchEndsAt: 0,
  hostId: null as string | null,
  players: new Map<string, ServerPlayer>(),
  disconnected: new Map<string, ServerPlayer>(),
  tokens: new Map<string, TokenRecord>(),
  projectiles: new Map<number, Projectile>(),
  killFeed: [] as KillFeedItem[],
  nextProjectileId: 1,
  nextFeedId: 1,
  spawnCursor: 0,
  lastSnapshotAt: 0,
};

function roomOccupancy(): number {
  return room.players.size + room.disconnected.size;
}

const colorPalette = ['#ff4d6d', '#ff9f1c', '#ffe66d', '#2ec4b6', '#38bdf8', '#8b5cf6', '#f472b6', '#a3e635', '#fb7185', '#c084fc'];

function cleanName(value: unknown): string {
  const normalized = String(value ?? '').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 18);
  return normalized || `Recruit-${Math.floor(Math.random() * 900 + 100)}`;
}

function cleanColor(value: unknown): string {
  const candidate = String(value ?? '');
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : colorPalette[room.players.size % colorPalette.length];
}

function defaultInput(): InputCommand {
  return { seq: 0, left: false, right: false, jump: false, jetpack: false, shoot: false, reload: false, aimAngle: 0 };
}

function newPlayer(socketId: string, payload: JoinPayload, now: number): ServerPlayer {
  const player: ServerPlayer = {
    id: randomUUID(), socketId, name: cleanName(payload.name), color: cleanColor(payload.color),
    x: 0, y: 0, vx: 0, vy: 0, grounded: false, fuel: WORLD.maxFuel, jetpacking: false,
    aimAngle: 0, hp: WORLD.playerMaxHp, ammo: WORLD.magazineSize, alive: true, respawnAt: null,
    spawnProtectedUntil: 0, reloadEndsAt: null, nextShotAt: 0, input: defaultInput(), lastInputSeq: 0,
    score: { kills: 0, deaths: 0, damage: 0 }, joinedAt: now,
  };
  resetPhysicsPlayer(player, room.spawnCursor++);
  return player;
}

function resetScores(): void {
  for (const player of room.players.values()) {
    player.score = { kills: 0, deaths: 0, damage: 0 };
  }
}

function spawnPlayer(player: ServerPlayer, now: number): void {
  resetPhysicsPlayer(player, room.spawnCursor++);
  player.hp = WORLD.playerMaxHp;
  player.ammo = WORLD.magazineSize;
  player.alive = true;
  player.respawnAt = null;
  player.reloadEndsAt = null;
  player.spawnProtectedUntil = now + 2_000;
  player.input.jump = false;
  player.input.shoot = false;
}

function sortedLeaderboard(): LeaderboardEntry[] {
  return [...room.players.values()]
    .sort((a, b) => b.score.kills - a.score.kills || a.score.deaths - b.score.deaths || b.score.damage - a.score.damage || a.joinedAt - b.joinedAt)
    .map((p) => ({ id: p.id, name: p.name, color: p.color, ...p.score }));
}

function playerSnapshot(player: ServerPlayer): PlayerSnapshot {
  return {
    id: player.id, name: player.name, color: player.color, x: player.x, y: player.y, vx: player.vx, vy: player.vy,
    aimAngle: player.aimAngle, hp: player.hp, maxHp: WORLD.playerMaxHp, fuel: player.fuel, maxFuel: WORLD.maxFuel,
    ammo: player.ammo, magazineSize: WORLD.magazineSize, grounded: player.grounded, jetpacking: player.jetpacking,
    shooting: player.input.shoot && player.alive, alive: player.alive, respawnAt: player.respawnAt,
    spawnProtectedUntil: player.spawnProtectedUntil, lastInputSeq: player.lastInputSeq, score: { ...player.score },
  };
}

function createSnapshot(now: number): GameSnapshot {
  const timeRemaining = room.phase === 'PLAYING' ? remainingMatchMs(room.phase, room.matchEndsAt, now) : room.phase === 'COUNTDOWN' ? Math.max(0, room.countdownEndsAt - now) : 0;
  return {
    roomId: ROOM_ID, serverInstanceId: INSTANCE_ID, serverTime: now, phase: room.phase, paused: room.paused, timeRemaining, countdown: room.phase === 'COUNTDOWN' ? Math.ceil(timeRemaining / 1000) : 0,
    playerCount: room.players.size, maxPlayers: room.capacity, hostId: room.hostId,
    players: [...room.players.values()].map(playerSnapshot),
    projectiles: [...room.projectiles.values()].map(({ id, x, y, vx, vy, ownerId }) => ({ id, x, y, vx, vy, ownerId })),
    killFeed: room.killFeed.slice(0, 5), leaderboard: sortedLeaderboard(),
  };
}

function broadcastSnapshot(now = Date.now()): void {
  room.lastSnapshotAt = now;
  io.to(ROOM_ID).volatile.emit('snapshot', createSnapshot(now));
}

function announce(message: string, type: 'info' | 'error' = 'info'): void {
  io.to(ROOM_ID).emit('notice', { message, type });
}

function startCountdown(now: number): boolean {
  if (room.players.size < MIN_PLAYERS_TO_START) return false;
  resetScores();
  room.projectiles.clear();
  room.killFeed = [];
  room.phase = 'COUNTDOWN';
  room.paused = false;
  room.countdownEndsAt = now + 3_000;
  room.matchEndsAt = 0;
  for (const player of room.players.values()) spawnPlayer(player, now);
  announce('Match starting — lock and load.');
  return true;
}

function beginMatch(now: number): void {
  room.phase = 'PLAYING';
  room.matchEndsAt = now + room.durationSeconds * 1000;
  announce('Fight!');
}

function endMatch(): void {
  room.phase = 'RESULTS';
  room.paused = false;
  room.projectiles.clear();
  for (const player of room.players.values()) player.input = defaultInput();
  io.to(ROOM_ID).emit('matchEnded', { leaderboard: sortedLeaderboard() });
  announce('Round over. The scoreboard is locked.');
}

function returnToLobby(): void {
  room.phase = 'LOBBY';
  room.paused = false;
  room.projectiles.clear();
  room.killFeed = [];
  for (const player of room.players.values()) {
    player.hp = WORLD.playerMaxHp;
    player.fuel = WORLD.maxFuel;
    player.ammo = WORLD.magazineSize;
    player.alive = true;
    player.respawnAt = null;
    player.input = defaultInput();
  }
}

function validateHost(socket: Socket, secret: string): boolean {
  const player = [...room.players.values()].find((candidate) => candidate.socketId === socket.id);
  const isRoomHost = Boolean(player && room.hostId === player.id);
  const hasValidSecret = Boolean(HOST_SECRET) && secret === HOST_SECRET;
  return isRoomHost || hasValidSecret;
}

function handleHostAction(socket: Socket, payload: HostActionPayload): void {
  if (!validateHost(socket, payload.secret)) {
    socket.emit('errorMessage', { message: 'Host secret rejected.' });
    return;
  }
  const now = Date.now();
  switch (payload.action) {
    case 'start':
      if (room.phase === 'LOBBY' || room.phase === 'RESULTS') {
        if (!startCountdown(now)) socket.emit('errorMessage', { message: 'At least 2 operatives are required to deploy.' });
      }
      break;
    case 'pause':
      if (room.phase === 'PLAYING') room.paused = !room.paused;
      break;
    case 'end':
      if (room.phase === 'PLAYING' || room.phase === 'COUNTDOWN') endMatch();
      break;
    case 'restart':
      if (room.players.size < MIN_PLAYERS_TO_START) {
        socket.emit('errorMessage', { message: 'At least 2 operatives are required to deploy.' });
        break;
      }
      returnToLobby();
      startCountdown(now);
      break;
    case 'lobby':
      returnToLobby();
      announce('Lobby reopened. Waiting for the next fireteam.');
      break;
    case 'duration':
      room.durationSeconds = Math.min(1_800, Math.max(30, Number(payload.durationSeconds) || DEFAULT_DURATION));
      break;
    case 'capacity':
      if (room.phase === 'LOBBY' || room.phase === 'RESULTS') {
        room.capacity = Math.min(30, Math.max(roomOccupancy(), 2, Number(payload.capacity) || DEFAULT_CAPACITY));
        announce(`Owner set the room capacity to ${room.capacity}.`);
      }
      break;
    case 'kick': {
      const target = room.players.get(payload.playerId ?? '');
      if (target) io.sockets.sockets.get(target.socketId)?.disconnect(true);
      break;
    }
  }
  broadcastSnapshot(now);
}

function eliminate(victim: ServerPlayer, killer: ServerPlayer | undefined, now: number): void {
  if (!victim.alive) return;
  victim.alive = false;
  victim.hp = 0;
  victim.respawnAt = now + 3_000;
  victim.vx = 0;
  victim.vy = 0;
  victim.score = addDeath(victim.score);
  if (killer && killer.id !== victim.id) killer.score = addKill(killer.score);
  const item: KillFeedItem = { id: room.nextFeedId++, killer: killer?.name ?? 'The arena', victim: victim.name, at: now };
  room.killFeed.unshift(item);
  room.killFeed = room.killFeed.slice(0, 8);
  io.to(ROOM_ID).emit('elimination', { ...item, killerId: killer?.id ?? null, victimId: victim.id });
}

function updateProjectiles(dt: number, now: number): void {
  for (const projectile of room.projectiles.values()) {
    const nextX = projectile.x + projectile.vx * dt;
    const nextY = projectile.y + projectile.vy * dt;
    if (segmentHitsPlatform(projectile.x, projectile.y, nextX, nextY)) {
      room.projectiles.delete(projectile.id);
      continue;
    }
    projectile.x = nextX;
    projectile.y = nextY;
    projectile.ttl -= dt;
    if (projectile.ttl <= 0 || projectile.x < 0 || projectile.x > WORLD.width || projectile.y < 0 || projectile.y > WORLD.height) {
      room.projectiles.delete(projectile.id);
      continue;
    }
    for (const target of room.players.values()) {
      if (!target.alive || target.id === projectile.ownerId || target.spawnProtectedUntil > now) continue;
      if (circleHitsPlayer(projectile.x, projectile.y, 5, target)) {
        const shooter = room.players.get(projectile.ownerId);
        target.hp = applyDamage(target.hp, WORLD.bulletDamage);
        if (shooter) shooter.score = addDamage(shooter.score, WORLD.bulletDamage);
        io.to(ROOM_ID).emit('hit', { targetId: target.id, shooterId: shooter?.id ?? null, hp: target.hp });
        if (target.hp <= 0) eliminate(target, shooter, now);
        room.projectiles.delete(projectile.id);
        break;
      }
    }
  }
}

function updatePlayer(player: ServerPlayer, dt: number, now: number): void {
  if (!player.alive) {
    if (isRespawnDue(player.alive, player.respawnAt, now)) spawnPlayer(player, now);
    return;
  }
  if (player.reloadEndsAt && now >= player.reloadEndsAt) {
    player.ammo = WORLD.magazineSize;
    player.reloadEndsAt = null;
  }
  stepPlayer(player, player.input, dt, PLATFORM_LAYOUT);
  if (player.input.reload && player.ammo < WORLD.magazineSize && !player.reloadEndsAt) player.reloadEndsAt = now + WORLD.reloadSeconds * 1000;
  if (player.input.shoot && player.ammo > 0 && !player.reloadEndsAt && now >= player.nextShotAt) {
    const angle = Number.isFinite(player.aimAngle) ? player.aimAngle : 0;
    const directionX = Math.cos(angle);
    const directionY = Math.sin(angle);
    const projectile: Projectile = {
      id: room.nextProjectileId++, ownerId: player.id,
      x: player.x + WORLD.playerWidth / 2 + directionX * 24,
      y: player.y + 25 + directionY * 24,
      vx: directionX * WORLD.bulletSpeed + player.vx * 0.35,
      vy: directionY * WORLD.bulletSpeed + player.vy * 0.15,
      ttl: WORLD.bulletLifetime,
    };
    room.projectiles.set(projectile.id, projectile);
    // Reliable shot events make short-lived bullets visible to remote clients even
    // when a projectile is created and hits between two volatile snapshots.
    io.to(ROOM_ID).emit('shot', { id: projectile.id, ownerId: projectile.ownerId, x: projectile.x, y: projectile.y, vx: projectile.vx, vy: projectile.vy });
    if (DEBUG_COMBAT) console.log(`[combat] shot room=${ROOM_ID} player=${player.id} projectile=${projectile.id} angle=${angle.toFixed(3)}`);
    player.ammo -= 1;
    player.nextShotAt = now + WORLD.fireInterval * 1000;
  }
}

function simulationTick(): void {
  const now = Date.now();
  if (room.phase === 'COUNTDOWN' && now >= room.countdownEndsAt) beginMatch(now);
  if (room.phase !== 'PLAYING' || room.paused) {
    if (now - room.lastSnapshotAt >= 1000 / WORLD.snapshotRate) broadcastSnapshot(now);
    return;
  }
  if (now >= room.matchEndsAt) {
    endMatch();
    broadcastSnapshot(now);
    return;
  }
  const dt = 1 / WORLD.tickRate;
  for (const player of room.players.values()) updatePlayer(player, dt, now);
  updateProjectiles(dt, now);
  if (now - room.lastSnapshotAt >= 1000 / WORLD.snapshotRate) broadcastSnapshot(now);
}

io.on('connection', (socket) => {
  console.log(`[socket] connected id=${socket.id} origin=${String(socket.handshake.headers.origin ?? 'direct')} instance=${INSTANCE_ID}`);
  socket.emit('connected', { connectionId: socket.id, maxPlayers: room.capacity });

  socket.on('join', (payload: JoinPayload) => {
    payload = payload || { name: '', color: '' };
    const now = Date.now();
    const requestedToken = typeof payload.reconnectToken === 'string' ? payload.reconnectToken.trim() : '';
    const token = requestedToken ? room.tokens.get(requestedToken) : undefined;
    const reconnectAttempt = Boolean(requestedToken);
    if (reconnectAttempt && (!token || token.expiresAt <= now)) {
      if (token) {
        room.tokens.delete(requestedToken);
        room.disconnected.delete(token.playerId);
      }
      socket.emit('errorMessage', { code: 'RECONNECT_EXPIRED', message: 'Your previous operative session expired. Join again as a new operative.' });
      return;
    }
    const existingPlayerId = socket.data.playerId as string | undefined;
    const existingPlayer = existingPlayerId ? room.players.get(existingPlayerId) : undefined;
    if (existingPlayer && existingPlayer.socketId === socket.id) {
      const existingToken = [...room.tokens.entries()].find(([, record]) => record.playerId === existingPlayer.id && record.expiresAt > now)?.[0];
      const reconnectToken = existingToken || randomBytes(18).toString('hex');
      room.tokens.set(reconnectToken, { playerId: existingPlayer.id, expiresAt: now + 24 * 60 * 60 * 1000 });
      const session: SessionPayload = { id: existingPlayer.id, reconnectToken, isHost: room.hostId === existingPlayer.id, phase: room.phase, maxPlayers: room.capacity, roomId: ROOM_ID, serverInstanceId: INSTANCE_ID };
      socket.emit('session', session);
      return;
    }
    if (roomOccupancy() >= room.capacity && !token) {
      socket.emit('errorMessage', { message: 'The arena is full. Try the next round.' });
      return;
    }
    let player: ServerPlayer | undefined;
    const rejoining = Boolean(token);
    if (token) {
      player = room.players.get(token.playerId) || room.disconnected.get(token.playerId);
      if (player) {
        if (player.socketId && player.socketId !== socket.id) {
          socket.emit('errorMessage', { code: 'SESSION_ACTIVE', message: 'That operative is already connected. Open a new join session instead.' });
          return;
        } else {
          player.socketId = socket.id;
          player.name = cleanName(payload.name || player.name);
          player.color = cleanColor(payload.color || player.color);
          // Input sequence numbers are scoped to a socket connection. Resetting
          // them here prevents a reconnect from being ignored forever.
          player.lastInputSeq = 0;
          player.input = defaultInput();
        }
      }
    }
    if (rejoining && !player) {
      room.tokens.delete(requestedToken);
      socket.emit('errorMessage', { code: 'RECONNECT_EXPIRED', message: 'Your previous operative session expired. Join again as a new operative.' });
      return;
    }
    if (!player) player = newPlayer(socket.id, payload, now);
    if (!rejoining && (room.phase === 'PLAYING' || room.phase === 'COUNTDOWN')) player.spawnProtectedUntil = now + 2_000;
    room.disconnected.delete(player.id);
    room.players.set(player.id, player);
    if (!room.hostId) room.hostId = player.id;
    socket.data.playerId = player.id;
    socket.join(ROOM_ID);
    const reconnectToken = randomBytes(18).toString('hex');
    if (requestedToken) room.tokens.delete(requestedToken);
    room.tokens.set(reconnectToken, { playerId: player.id, expiresAt: now + 24 * 60 * 60 * 1000 });
    const session: SessionPayload = { id: player.id, reconnectToken, isHost: room.hostId === player.id, phase: room.phase, maxPlayers: room.capacity, roomId: ROOM_ID, serverInstanceId: INSTANCE_ID };
    socket.emit('session', session);
    socket.emit('snapshot', createSnapshot(now));
    console.log(`[room] join room=${ROOM_ID} player=${player.id} name=${player.name} players=${room.players.size}/${room.capacity} phase=${room.phase}`);
    announce(rejoining ? `${player.name} reconnected to the fireteam.` : `${player.name} joined the fireteam.`);
    broadcastSnapshot(now);
  });

  socket.on('input', (input: InputCommand) => {
    const player = room.players.get(socket.data.playerId);
    if (!player || !input || typeof input.seq !== 'number') return;
    if (input.seq <= player.lastInputSeq) return;
    player.lastInputSeq = input.seq;
    player.input = {
      seq: player.lastInputSeq,
      left: Boolean(input.left), right: Boolean(input.right), jump: Boolean(input.jump), jetpack: Boolean(input.jetpack),
      shoot: Boolean(input.shoot), reload: Boolean(input.reload), aimAngle: Math.max(-Math.PI * 2, Math.min(Math.PI * 2, Number(input.aimAngle) || 0)),
    };
    player.aimAngle = player.input.aimAngle;
  });

  socket.on('hostAction', (payload: HostActionPayload) => handleHostAction(socket, payload));
  socket.on('requestState', () => socket.emit('snapshot', createSnapshot(Date.now())));

  socket.on('disconnect', (reason) => {
    console.log(`[socket] disconnected id=${socket.id} reason=${reason}`);
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) return;
    const player = room.players.get(playerId);
    if (!player || player.socketId !== socket.id) return;
    player.socketId = '';
    player.input = defaultInput();
    player.reloadEndsAt = null;
    room.projectiles.forEach((projectile, projectileId) => {
      if (projectile.ownerId === playerId) room.projectiles.delete(projectileId);
    });
    room.tokens.forEach((record) => { if (record.playerId === playerId) record.expiresAt = Date.now() + RECONNECT_GRACE_MS; });
    room.players.delete(playerId);
    room.disconnected.set(playerId, player);
    if (room.hostId === playerId) room.hostId = room.players.keys().next().value ?? null;
    announce(`${player.name} left the fireteam.`);
    broadcastSnapshot();
  });
});

setInterval(simulationTick, 1000 / WORLD.tickRate);
setInterval(() => {
  const now = Date.now();
  for (const [token, record] of room.tokens) if (record.expiresAt < now) {
    room.tokens.delete(token);
    room.disconnected.delete(record.playerId);
  }
}, 60_000);

httpServer.listen(PORT, '0.0.0.0', () => console.log(`Lendzone server listening on port ${PORT} instance=${INSTANCE_ID} room=${ROOM_ID} maxPlayers=${room.capacity}`));
