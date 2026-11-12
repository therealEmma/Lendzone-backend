import { WORLD } from './types.js';
export function applyDamage(currentHp, damage, maxHp = WORLD.playerMaxHp) {
    return Math.max(0, Math.min(maxHp, currentHp - Math.max(0, damage)));
}
export function addDamage(score, amount) {
    return { ...score, damage: score.damage + Math.max(0, amount) };
}
export function addKill(score) {
    return { ...score, kills: score.kills + 1 };
}
export function addDeath(score) {
    return { ...score, deaths: score.deaths + 1 };
}
export function isRespawnDue(alive, respawnAt, now) {
    return !alive && respawnAt !== null && now >= respawnAt;
}
export function remainingMatchMs(phase, matchEndsAt, now) {
    return phase === 'PLAYING' ? Math.max(0, matchEndsAt - now) : 0;
}
//# sourceMappingURL=rules.js.map