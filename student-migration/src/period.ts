// Datas da migracao sao interpretadas em America/Sao_Paulo, que usa offset
// fixo -03:00 desde 2019 (sem horario de verao).
const SAO_PAULO_OFFSET = "-03:00";

export type AccessGroupPeriodicity = "DAILY" | "MONTHLY" | "YEARLY";

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseSaoPauloDate(value: string): Date | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const dateOnly = DATE_ONLY_PATTERN.exec(trimmed);
  const candidate = dateOnly ? `${trimmed}T00:00:00${SAO_PAULO_OFFSET}` : trimmed;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function computeAccessEndsAt(
  accessStartsAt: string,
  periodicity: AccessGroupPeriodicity,
  periodicityValue: number,
): { accessStartsAtIso: string; accessEndsAtIso: string } {
  if (!Number.isInteger(periodicityValue) || periodicityValue < 1) {
    throw new Error(`periodicityValue must be a positive integer, got ${periodicityValue}`);
  }

  const match = DATE_ONLY_PATTERN.exec(accessStartsAt.trim());
  if (!match) {
    throw new Error(`accessStartsAt must be YYYY-MM-DD, got "${accessStartsAt}"`);
  }

  const [, yearRaw, monthRaw, dayRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  const start = parseSaoPauloDate(accessStartsAt.trim());
  if (!start) {
    throw new Error(`accessStartsAt is not a valid date: "${accessStartsAt}"`);
  }

  let end: { year: number; month: number; day: number };
  switch (periodicity) {
    case "DAILY": {
      const base = new Date(Date.UTC(year, month - 1, day + periodicityValue));
      end = {
        year: base.getUTCFullYear(),
        month: base.getUTCMonth() + 1,
        day: base.getUTCDate(),
      };
      break;
    }
    case "MONTHLY":
      end = addCalendarMonths(year, month, day, periodicityValue);
      break;
    case "YEARLY":
      end = addCalendarMonths(year, month, day, periodicityValue * 12);
      break;
  }

  const endIsoLocal = `${pad(end.year, 4)}-${pad(end.month)}-${pad(end.day)}T00:00:00${SAO_PAULO_OFFSET}`;
  const endDate = new Date(endIsoLocal);
  if (Number.isNaN(endDate.getTime())) {
    throw new Error(`computed accessEndsAt is invalid: ${endIsoLocal}`);
  }

  return {
    accessStartsAtIso: start.toISOString(),
    accessEndsAtIso: endDate.toISOString(),
  };
}

export function describeRemaining(
  now: Date,
  accessEndsAtIso: string,
): {
  expired: boolean;
  remainingDays: number;
} {
  const end = new Date(accessEndsAtIso);
  const diffMs = end.getTime() - now.getTime();
  const remainingDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return { expired: diffMs <= 0, remainingDays };
}

function addCalendarMonths(
  year: number,
  month: number,
  day: number,
  months: number,
): { year: number; month: number; day: number } {
  const totalMonths = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return { year: targetYear, month: targetMonth, day: clampedDay };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}
