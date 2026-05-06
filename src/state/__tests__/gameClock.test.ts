import { describe, expect, test } from "vitest";
import {
  addMinutes,
  coerceIsoDate,
  coerceIsoDateTime,
  datePart,
  diffDays,
  formatForPrompt,
  isSameDay,
  makeDateTime,
  timePart,
} from "../gameClock.js";

describe("makeDateTime", () => {
  test("round-trip: combines date and time into canonical datetime", () => {
    expect(makeDateTime("1923-10-17", "8:15")).toBe("1923-10-17T08:15:00");
    expect(makeDateTime("1923-10-17", "08:15")).toBe("1923-10-17T08:15:00");
    expect(makeDateTime("1923-10-17", "08:15:30")).toBe("1923-10-17T08:15:30");
  });

  test("rejects malformed date input", () => {
    expect(() => makeDateTime("1923-13-17", "08:15")).toThrow();
    expect(() => makeDateTime("1923-00-17", "08:15")).toThrow();
    expect(() => makeDateTime("not-a-date", "08:15")).toThrow();
  });

  test("rejects malformed time input", () => {
    expect(() => makeDateTime("1923-10-17", "25:00")).toThrow();
    expect(() => makeDateTime("1923-10-17", "badtime")).toThrow();
    expect(() => makeDateTime("1923-10-17", "08:60")).toThrow();
  });
});

describe("datePart", () => {
  test("slices the date part from a datetime", () => {
    expect(datePart("1923-10-17T08:15:00")).toBe("1923-10-17");
  });

  test("rejects malformed datetime", () => {
    expect(() => datePart("1923-13-17T08:15:00")).toThrow();
    expect(() => datePart("not-valid")).toThrow();
  });
});

describe("timePart", () => {
  test("slices HH:MM from a datetime, dropping seconds", () => {
    expect(timePart("1923-10-17T08:15:00")).toBe("08:15");
    expect(timePart("1923-10-17T23:59:45")).toBe("23:59");
  });

  test("rejects malformed datetime", () => {
    expect(() => timePart("1923-13-17T08:15:00")).toThrow();
    expect(() => timePart("not-valid")).toThrow();
  });
});

describe("addMinutes", () => {
  test("0 minutes returns the same datetime", () => {
    expect(addMinutes("1923-10-17T08:15:00", 0)).toBe("1923-10-17T08:15:00");
  });

  test("+1 minute, no rollover", () => {
    expect(addMinutes("1923-10-17T08:15:00", 1)).toBe("1923-10-17T08:16:00");
  });

  test("+60 minutes, hour rollover", () => {
    expect(addMinutes("1923-10-17T08:15:00", 60)).toBe("1923-10-17T09:15:00");
  });

  test("+1440 minutes (24 hours), day rollover", () => {
    expect(addMinutes("1923-10-17T08:15:00", 1440)).toBe("1923-10-18T08:15:00");
  });

  test("cross-month boundary", () => {
    expect(addMinutes("1923-10-31T23:59:00", 1)).toBe("1923-11-01T00:00:00");
  });

  test("cross-year boundary", () => {
    expect(addMinutes("1923-12-31T23:59:00", 1)).toBe("1924-01-01T00:00:00");
  });

  test("leap year: into Feb 29", () => {
    expect(addMinutes("2024-02-28T23:59:00", 1)).toBe("2024-02-29T00:00:00");
  });

  test("leap year: out of Feb 29", () => {
    expect(addMinutes("2024-02-29T23:59:00", 1)).toBe("2024-03-01T00:00:00");
  });

  test("non-leap year: Feb 28 rolls to Mar 1", () => {
    expect(addMinutes("2023-02-28T23:59:00", 1)).toBe("2023-03-01T00:00:00");
  });

  test("century non-leap (1900): Feb 28 rolls to Mar 1", () => {
    expect(addMinutes("1900-02-28T23:59:00", 1)).toBe("1900-03-01T00:00:00");
  });

  test("400-divisible leap (2000): into Feb 29", () => {
    expect(addMinutes("2000-02-28T23:59:00", 1)).toBe("2000-02-29T00:00:00");
  });

  test("DST-trap input: no timezone shift applied", () => {
    expect(addMinutes("2024-03-31T01:30:00", 60)).toBe("2024-03-31T02:30:00");
  });

  test("negative minutes, cross-day backward", () => {
    expect(addMinutes("1923-10-17T00:15:00", -30)).toBe("1923-10-16T23:45:00");
  });

  test("partial hour addition: cross-hour with remainder", () => {
    expect(addMinutes("1923-10-17T08:15:00", 50)).toBe("1923-10-17T09:05:00");
  });
});

describe("diffDays", () => {
  test("same date → 0", () => {
    expect(diffDays("1923-10-17T00:00:00", "1923-10-17")).toBe(0);
  });

  test("one day forward → 1", () => {
    expect(diffDays("1923-10-18T00:00:00", "1923-10-17")).toBe(1);
  });

  test("one day backward → -1", () => {
    expect(diffDays("1923-10-17T23:59:00", "1923-10-18")).toBe(-1);
  });

  test("cross-month positive", () => {
    expect(diffDays("1923-11-01T00:00:00", "1923-10-01")).toBe(31);
  });

  test("cross-year positive", () => {
    expect(diffDays("1924-01-01T00:00:00", "1923-12-31")).toBe(1);
    expect(diffDays("1924-01-01T00:00:00", "1923-01-01")).toBe(365);
  });
});

describe("isSameDay", () => {
  test("different times on the same day → true", () => {
    expect(isSameDay("1923-10-17T00:00:00", "1923-10-17T23:59:00")).toBe(true);
  });

  test("midnight boundary → false", () => {
    expect(isSameDay("1923-10-17T23:59:00", "1923-10-18T00:00:00")).toBe(false);
  });
});

describe("formatForPrompt", () => {
  test("replaces T with space and drops seconds", () => {
    expect(formatForPrompt("1923-10-17T08:15:00")).toBe("1923-10-17 08:15");
  });
});

describe("coerceIsoDate", () => {
  test("already-canonical date passes through", () => {
    expect(coerceIsoDate("1923-10-17")).toBe("1923-10-17");
  });

  test("trims whitespace", () => {
    expect(coerceIsoDate("  1923-10-17  ")).toBe("1923-10-17");
  });

  test("slices date from full ISO datetime", () => {
    expect(coerceIsoDate("1923-10-17T08:15:00")).toBe("1923-10-17");
  });

  test("slices date from G2 readable form", () => {
    expect(coerceIsoDate("1923-10-17 08:15")).toBe("1923-10-17");
  });

  test("garbage string → null", () => {
    expect(coerceIsoDate("yesterday")).toBeNull();
  });

  test("empty string → null", () => {
    expect(coerceIsoDate("")).toBeNull();
  });

  test("wrong length date → null", () => {
    expect(coerceIsoDate("23-10-17")).toBeNull();
  });

  test("invalid calendar date → null", () => {
    expect(coerceIsoDate("1923-02-31")).toBeNull();
  });
});

describe("coerceIsoDateTime", () => {
  test("already-canonical datetime passes through", () => {
    expect(coerceIsoDateTime("1923-10-17T08:15:00")).toBe(
      "1923-10-17T08:15:00"
    );
  });

  test("space separator normalized to T", () => {
    expect(coerceIsoDateTime("1923-10-17 08:15:00")).toBe(
      "1923-10-17T08:15:00"
    );
  });

  test("missing seconds appended", () => {
    expect(coerceIsoDateTime("1923-10-17T08:15")).toBe("1923-10-17T08:15:00");
  });

  test("date-only string → null (not a full datetime)", () => {
    expect(coerceIsoDateTime("1923-10-17")).toBeNull();
  });

  test("garbage string → null", () => {
    expect(coerceIsoDateTime("not-a-datetime")).toBeNull();
  });

  test("out-of-range hour → null", () => {
    expect(coerceIsoDateTime("1923-10-17T99:15:00")).toBeNull();
  });
});
