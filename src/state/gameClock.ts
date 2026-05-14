export const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MINUTES_PER_DAY = 1440;

interface DateParts {
  year: number;
  month: number;
  day: number;
}

interface DateTimeParts extends DateParts {
  hour: number;
  minute: number;
  second: number;
}

export function makeDateTime(date: string, time: string): string {
  const d = parseIsoDate(date);
  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!timeMatch) {
    throw new Error(`Invalid time "${time}". Expected HH:MM or HH:MM:SS.`);
  }
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = timeMatch[3] === undefined ? 0 : Number(timeMatch[3]);
  assertValidTime(hour, minute, second, time);
  return `${formatDateParts(d)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

export function datePart(dt: string): string {
  return formatDateParts(parseIsoDateTime(dt));
}

export function timePart(dt: string): string {
  const parsed = parseIsoDateTime(dt);
  return `${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
}

export function addMinutes(dt: string, mins: number): string {
  if (!Number.isInteger(mins)) {
    throw new Error(`addMinutes expects an integer minute delta, got ${mins}.`);
  }
  const parsed = parseIsoDateTime(dt);
  const dayNumber = daysFromCivil(parsed.year, parsed.month, parsed.day);
  const minuteOfDay = parsed.hour * 60 + parsed.minute;
  const total = dayNumber * MINUTES_PER_DAY + minuteOfDay + mins;
  const nextDay = floorDiv(total, MINUTES_PER_DAY);
  const nextMinuteOfDay = mod(total, MINUTES_PER_DAY);
  const nextDate = civilFromDays(nextDay);
  const hour = Math.floor(nextMinuteOfDay / 60);
  const minute = nextMinuteOfDay % 60;
  return `${formatDateParts(nextDate)}T${pad2(hour)}:${pad2(minute)}:${pad2(parsed.second)}`;
}

export function diffDays(a: string, b: string): number {
  const left = parseIsoDateOrDateTime(a);
  const right = parseIsoDateOrDateTime(b);
  return (
    daysFromCivil(left.year, left.month, left.day) -
    daysFromCivil(right.year, right.month, right.day)
  );
}

export function isSameDay(a: string, b: string): boolean {
  return datePart(a) === datePart(b);
}

export function formatForPrompt(dt: string): string {
  return `${datePart(dt)} ${timePart(dt)}`;
}

export function coerceIsoDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 10) return null;
  const candidate = trimmed.slice(0, 10);
  if (!ISO_DATE_RE.test(candidate)) return null;
  return isValidIsoDate(candidate) ? candidate : null;
}

export function coerceIsoDateTime(raw: string): string | null {
  const trimmed = raw.trim();
  const normalized =
    trimmed.length >= 16 && trimmed[10] === " "
      ? `${trimmed.slice(0, 10)}T${trimmed.slice(11)}`
      : trimmed;
  const candidate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)
    ? `${normalized}:00`
    : normalized.slice(0, 19);
  if (!ISO_DATETIME_RE.test(candidate)) return null;
  return isValidIsoDateTime(candidate) ? candidate : null;
}

function parseIsoDateOrDateTime(value: string): DateParts {
  if (ISO_DATE_RE.test(value)) return parseIsoDate(value);
  return parseIsoDateTime(value);
}

function parseIsoDate(value: string): DateParts {
  if (!ISO_DATE_RE.test(value) || !isValidIsoDate(value)) {
    throw new Error(`Invalid ISO date "${value}". Expected YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function parseIsoDateTime(value: string): DateTimeParts {
  if (!ISO_DATETIME_RE.test(value) || !isValidIsoDateTime(value)) {
    throw new Error(
      `Invalid ISO datetime "${value}". Expected YYYY-MM-DDTHH:MM:SS.`
    );
  }
  const [date, time] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  return { year, month, day, hour, minute, second };
}

function isValidIsoDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  return isValidDateParts(year, month, day);
}

function isValidIsoDateTime(value: string): boolean {
  const [date, time] = value.split("T");
  if (!isValidIsoDate(date)) return false;
  const [hour, minute, second] = time.split(":").map(Number);
  return isValidTime(hour, minute, second);
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    year >= 0 &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12 &&
    Number.isInteger(day) &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

function assertValidTime(
  hour: number,
  minute: number,
  second: number,
  raw: string
): void {
  if (!isValidTime(hour, minute, second)) {
    throw new Error(`Invalid time "${raw}". Expected 00:00 through 23:59.`);
  }
}

function isValidTime(hour: number, minute: number, second: number): boolean {
  return (
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23 &&
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute <= 59 &&
    Number.isInteger(second) &&
    second >= 0 &&
    second <= 59
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function formatDateParts(parts: DateParts): string {
  return `${pad4(parts.year)}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

// Howard Hinnant's civil calendar algorithms. They operate on proleptic
// Gregorian dates without constructing JS Date objects or touching timezones.
function daysFromCivil(year: number, month: number, day: number): number {
  let y = year;
  y -= month <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe;
}

function civilFromDays(days: number): DateParts {
  const era = Math.floor(days / 146097);
  const doe = days - era * 146097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36524) -
      Math.floor(doe / 146096)) /
      365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = y + (month <= 2 ? 1 : 0);
  return { year, month, day };
}
