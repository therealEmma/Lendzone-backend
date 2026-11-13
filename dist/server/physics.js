import { PLATFORM_LAYOUT, WORLD } from '../shared/types.js';
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
export function resetPhysicsPlayer(player, spawnIndex) {
    const spawn = PLAYER_SPAWNS[spawnIndex % PLAYER_SPAWNS.length];
    player.x = spawn.x;
    player.y = spawn.y;
    player.vx = 0;
    player.vy = 0;
    player.grounded = false;
    player.fuel = WORLD.maxFuel;
    player.jetpacking = false;
}
function overlapsX(x, width, platform) {
    return x + width > platform.x && x < platform.x + platform.width;
}
export function isPointBlocked(x, y, platforms = PLATFORM_LAYOUT) {
    return platforms.some((platform) => x >= platform.x && x <= platform.x + platform.width && y >= platform.y && y <= platform.y + platform.height);
}
export function stepPlayer(player, input, dt, platforms = PLATFORM_LAYOUT) {
    const direction = Number(input.right) - Number(input.left);
    const desiredSpeed = direction * WORLD.runSpeed;
    const acceleration = player.grounded ? 2200 : 1500;
    const blend = Math.min(1, acceleration * dt / WORLD.runSpeed);
    player.vx += (desiredSpeed - player.vx) * blend;
    if (direction === 0)
        player.vx *= Math.pow(player.grounded ? 0.0008 : 0.08, dt);
    if (input.jump && player.grounded) {
        player.vy = -WORLD.jumpSpeed;
        player.grounded = false;
    }
    player.jetpacking = input.jetpack && player.fuel > 0;
    if (player.jetpacking) {
        player.vy -= WORLD.jetpackAccel * dt;
        player.fuel = Math.max(0, player.fuel - WORLD.jetpackFuelPerSecond * dt);
    }
    else if (player.grounded) {
        player.fuel = Math.min(WORLD.maxFuel, player.fuel + WORLD.fuelRechargePerSecond * dt);
    }
    const previousY = player.y;
    player.vy += WORLD.gravity * dt;
    player.x += player.vx * dt;
    player.y += player.vy * dt;
    player.x = Math.max(36, Math.min(WORLD.width - 36 - WORLD.playerWidth, player.x));
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
    }
    else {
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
export function segmentHitsPlatform(x1, y1, x2, y2, platforms = PLATFORM_LAYOUT) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    for (const platform of platforms) {
        if (segmentIntersectsRect(x1, y1, dx, dy, platform))
            return true;
    }
    return false;
}
function segmentIntersectsRect(x, y, dx, dy, platform) {
    let near = 0;
    let far = 1;
    const left = platform.x;
    const right = platform.x + platform.width;
    const top = platform.y;
    const bottom = platform.y + platform.height;
    const minX = Math.min(x, x + dx);
    const maxX = Math.max(x, x + dx);
    const minY = Math.min(y, y + dy);
    const maxY = Math.max(y, y + dy);
    if (maxX < left || minX > right || maxY < top || minY > bottom)
        return false;
    let p = -dx;
    let q = x - left;
    if (p === 0) {
        if (q < 0)
            return false;
    }
    else {
        const ratio = q / p;
        if (p < 0) {
            if (ratio > far)
                return false;
            if (ratio > near)
                near = ratio;
        }
        else {
            if (ratio < near)
                return false;
            if (ratio < far)
                far = ratio;
        }
    }
    p = dx;
    q = right - x;
    if (p === 0) {
        if (q < 0)
            return false;
    }
    else {
        const ratio = q / p;
        if (p < 0) {
            if (ratio > far)
                return false;
            if (ratio > near)
                near = ratio;
        }
        else {
            if (ratio < near)
                return false;
            if (ratio < far)
                far = ratio;
        }
    }
    p = -dy;
    q = y - top;
    if (p === 0) {
        if (q < 0)
            return false;
    }
    else {
        const ratio = q / p;
        if (p < 0) {
            if (ratio > far)
                return false;
            if (ratio > near)
                near = ratio;
        }
        else {
            if (ratio < near)
                return false;
            if (ratio < far)
                far = ratio;
        }
    }
    p = dy;
    q = bottom - y;
    if (p === 0) {
        if (q < 0)
            return false;
    }
    else {
        const ratio = q / p;
        if (p < 0) {
            if (ratio > far)
                return false;
            if (ratio > near)
                near = ratio;
        }
        else {
            if (ratio < near)
                return false;
            if (ratio < far)
                far = ratio;
        }
    }
    return true;
}
export function circleHitsPlayer(x, y, radius, player) {
    const closestX = Math.max(player.x, Math.min(x, player.x + WORLD.playerWidth));
    const closestY = Math.max(player.y, Math.min(y, player.y + WORLD.playerHeight));
    const dx = x - closestX;
    const dy = y - closestY;
    return dx * dx + dy * dy <= radius * radius;
}
//# sourceMappingURL=physics.js.map