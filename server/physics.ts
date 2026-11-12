import { InputCommand, PLATFORM_LAYOUT, Platform, WORLD } from '../shared/types.js';

export interface PhysicsPlayer {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  fuel: number;
  jetpacking: boolean;
}

export const PLAYER_SPAWNS = [
  { x: 100, y: 900 }, { x: 300, y: 900 }, { x: 520, y: 900 }, { x: 760, y: 805 },
  { x: 980, y: 805 }, { x: 1210, y: 900 }, { x: 1430, y: 900 }, { x: 1660, y: 900 },
  { x: 1880, y: 750 }, { x: 2130, y: 750 }, { x: 470, y: 625 }, { x: 720, y: 625 },
  { x: 980, y: 520 }, { x: 1240, y: 520 }, { x: 1550, y: 580 }, { x: 1780, y: 580 },
  { x: 2070, y: 430 }, { x: 120, y: 345 }, { x: 270, y: 345 }, { x: 600, y: 255 },
  { x: 825, y: 255 }, { x: 1190, y: 315 }, { x: 1390, y: 315 }, { x: 1710, y: 225 },
  { x: 1930, y: 225 }, { x: 2170, y: 430 }, { x: 200, y: 1060 }, { x: 820, y: 1060 },
  { x: 1460, y: 1060 }, { x: 2050, y: 1060 },
];

export function resetPhysicsPlayer(player: PhysicsPlayer, spawnIndex: number): void {
  const spawn = PLAYER_SPAWNS[spawnIndex % PLAYER_SPAWNS.length];
  player.x = spawn.x;
  player.y = spawn.y;
  player.vx = 0;
  player.vy = 0;
  player.grounded = false;
  player.fuel = WORLD.maxFuel;
  player.jetpacking = false;
}

function overlapsX(x: number, width: number, platform: Platform): boolean {
  return x + width > platform.x && x < platform.x + platform.width;
}

export function isPointBlocked(x: number, y: number, platforms: Platform[] = PLATFORM_LAYOUT): boolean {
  return platforms.some((platform) => x >= platform.x && x <= platform.x + platform.width && y >= platform.y && y <= platform.y + platform.height);
}

export function stepPlayer(
  player: PhysicsPlayer,
  input: Pick<InputCommand, 'left' | 'right' | 'jump' | 'jetpack'>,
  dt: number,
  platforms: Platform[] = PLATFORM_LAYOUT,
): void {
  const direction = Number(input.right) - Number(input.left);
  const desiredSpeed = direction * WORLD.runSpeed;
  const acceleration = player.grounded ? 2200 : 1500;
  const blend = Math.min(1, acceleration * dt / WORLD.runSpeed);
  player.vx += (desiredSpeed - player.vx) * blend;
  if (direction === 0) player.vx *= Math.pow(player.grounded ? 0.0008 : 0.08, dt);

  if (input.jump && player.grounded) {
    player.vy = -WORLD.jumpSpeed;
    player.grounded = false;
  }

  player.jetpacking = input.jetpack && player.fuel > 0;
  if (player.jetpacking) {
    player.vy -= WORLD.jetpackAccel * dt;
    player.fuel = Math.max(0, player.fuel - WORLD.jetpackFuelPerSecond * dt);
  } else if (player.grounded) {
    player.fuel = Math.min(WORLD.maxFuel, player.fuel + WORLD.fuelRechargePerSecond * dt);
  }

  const previousY = player.y;
  const previousX = player.x;
  player.vy += WORLD.gravity * dt;
  player.x += player.vx * dt;
  player.y += player.vy * dt;

  player.x = Math.max(36, Math.min(WORLD.width - 36 - WORLD.playerWidth, player.x));
  for (const platform of platforms) {
    if (platform.kind !== 'cover' || player.y + WORLD.playerHeight <= platform.y + 5 || player.y >= platform.y + platform.height - 5) continue;
    const previousRight = previousX + WORLD.playerWidth;
    const currentRight = player.x + WORLD.playerWidth;
    if (player.vx > 0 && previousRight <= platform.x && currentRight > platform.x) {
      player.x = platform.x - WORLD.playerWidth;
      player.vx = 0;
    } else if (player.vx < 0 && previousX >= platform.x + platform.width && player.x < platform.x + platform.width) {
      player.x = platform.x + platform.width;
      player.vx = 0;
    }
  }
  player.grounded = false;

  if (player.vy >= 0) {
    for (const platform of platforms) {
      const previousBottom = previousY + WORLD.playerHeight;
      const currentBottom = player.y + WORLD.playerHeight;
      if (overlapsX(player.x + 4, WORLD.playerWidth - 8, platform) && previousBottom <= platform.y + 2 && currentBottom >= platform.y) {
        player.y = platform.y - WORLD.playerHeight;
        player.vy = 0;
        player.grounded = true;
        break;
      }
    }
  } else {
    for (const platform of platforms) {
      const previousTop = previousY;
      const currentTop = player.y;
      if (overlapsX(player.x + 4, WORLD.playerWidth - 8, platform) && previousTop >= platform.y + platform.height - 2 && currentTop <= platform.y + platform.height) {
        player.y = platform.y + platform.height;
        player.vy = 0;
        break;
      }
    }
  }

  if (player.y > WORLD.height + 100) {
    resetPhysicsPlayer(player, 0);
  }
}

export function segmentHitsPlatform(x1: number, y1: number, x2: number, y2: number, platforms: Platform[] = PLATFORM_LAYOUT): boolean {
  const distance = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.ceil(distance / 12));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    if (isPointBlocked(x, y, platforms)) return true;
  }
  return false;
}

export function circleHitsPlayer(x: number, y: number, radius: number, player: { x: number; y: number }): boolean {
  const closestX = Math.max(player.x, Math.min(x, player.x + WORLD.playerWidth));
  const closestY = Math.max(player.y, Math.min(y, player.y + WORLD.playerHeight));
  return Math.hypot(x - closestX, y - closestY) <= radius;
}
