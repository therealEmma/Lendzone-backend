import { MatchPhase, ScoreLine, WORLD } from './types.js';

export function applyDamage(currentHp: number, damage: number, maxHp = WORLD.playerMaxHp): number {
  return Math.max(0, Math.min(maxHp, currentHp - Math.max(0, damage)));
}

export function addDamage(score: ScoreLine, amount: number): ScoreLine {
  return { ...score, damage: score.damage + Math.max(0, amount) };
}

export function addKill(score: ScoreLine): ScoreLine {
  return { ...score, kills: score.kills + 1 };
}

export function addDeath(score: ScoreLine): ScoreLine {
  return { ...score, deaths: score.deaths + 1 };
}

export function isRespawnDue(alive: boolean, respawnAt: number | null, now: number): boolean {
  return !alive && respawnAt !== null && now >= respawnAt;
}

export function remainingMatchMs(phase: MatchPhase, matchEndsAt: number, now: number): number {
  return phase === 'PLAYING' ? Math.max(0, matchEndsAt - now) : 0;
}
