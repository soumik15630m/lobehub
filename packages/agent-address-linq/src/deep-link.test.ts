import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildLinqDeepLink,
  createLinqLinkCode,
  extractLinqLinkCode,
  LINQ_LINK_CODE_ALPHABET,
  LINQ_LINK_CODE_LENGTH,
  LINQ_LINK_CODE_PATTERN,
  normalizeLinqNumber,
} from './deep-link';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeLinqNumber', () => {
  it('strips the punctuation people paste around an international number', () => {
    expect(normalizeLinqNumber('+1 (555) 000-2222')).toBe('+15550002222');
    expect(normalizeLinqNumber('  +1-555-000-2222  ')).toBe('+15550002222');
    expect(normalizeLinqNumber('+447700900123')).toBe('+447700900123');
  });

  it('completes a national-format number from the default country code', () => {
    expect(normalizeLinqNumber('555 000 2222', { defaultCountryCode: '1' })).toBe('+15550002222');
    // A leading `0` is a trunk prefix, not part of the subscriber number.
    expect(normalizeLinqNumber('07700 900123', { defaultCountryCode: '+44' })).toBe(
      '+447700900123',
    );
  });

  it('keeps a leading zero that is part of the national significant number', () => {
    // Italy, San Marino and Vatican City dial the `0` internationally: Rome
    // `06 …` is `+39 06 …`, not `+39 6 …`.
    expect(normalizeLinqNumber('06 6988 3712', { defaultCountryCode: '39' })).toBe('+390669883712');
    expect(normalizeLinqNumber('0549 882 555', { defaultCountryCode: '378' })).toBe(
      '+3780549882555',
    );
    expect(normalizeLinqNumber('06 6988 3712', { defaultCountryCode: '379' })).toBe(
      '+3790669883712',
    );
    // Côte d'Ivoire's mobile ranges carry the zero in the national significant
    // number too, so `07 …` is `+225 07 …`, not `+225 7 …`.
    expect(normalizeLinqNumber('07 5887 2091', { defaultCountryCode: '225' })).toBe(
      '+2250758872091',
    );
  });

  it('accepts a short number the plan actually assigns', () => {
    // E.164 caps a number at 15 digits but sets no global minimum: Niue hands
    // out four-digit national numbers under `+683`, so this is a destination,
    // not a typo.
    expect(normalizeLinqNumber('+683 5000')).toBe('+6835000');
    expect(normalizeLinqNumber('5000', { defaultCountryCode: '683' })).toBe('+6835000');
  });

  it('refuses a number the plan has no room for, at either end', () => {
    // Seven digits is fine for Niue but far too short for the NANP.
    expect(normalizeLinqNumber('+1234567')).toBeUndefined();
    expect(normalizeLinqNumber('555 000', { defaultCountryCode: '1' })).toBeUndefined();
  });

  it('rejects an extension instead of folding it into the destination', () => {
    // Stripping the punctuation would turn `ext. 9` into a ninth destination
    // digit and text the wrong number.
    expect(normalizeLinqNumber('+1 (555) 000-2222 ext. 9')).toBeUndefined();
    expect(normalizeLinqNumber('+1 (555) 000-2222 x9')).toBeUndefined();
    expect(
      normalizeLinqNumber('555 000 2222 extension 9', { defaultCountryCode: '1' }),
    ).toBeUndefined();
  });

  it('keeps the digits as dialled for an assigned calling code the plan does not model', () => {
    // `+379` is allocated to the Vatican, but the metadata reaches Vatican
    // numbers through the Italian plan, so there is no trunk-prefix rule of its
    // own: the digits are kept rather than guessed at.
    expect(normalizeLinqNumber('0669883712', { defaultCountryCode: '379' })).toBe('+3790669883712');
    expect(normalizeLinqNumber('+3790669883712')).toBe('+3790669883712');
    // Still E.164-shaped or nothing.
    expect(normalizeLinqNumber('123', { defaultCountryCode: '379' })).toBeUndefined();
  });

  it('refuses a calling code nobody assigns', () => {
    // The gap above is a closed set of known codes, not a licence to bless any
    // seven-digit string — or an unknown default country — as a destination.
    expect(normalizeLinqNumber('+9991234567')).toBeUndefined();
    expect(normalizeLinqNumber('+0000000')).toBeUndefined();
    expect(normalizeLinqNumber('1234567', { defaultCountryCode: '999' })).toBeUndefined();
  });

  it('refuses input it cannot normalize rather than guessing', () => {
    // A national number with no default country code is ambiguous.
    expect(normalizeLinqNumber('555 000 2222')).toBeUndefined();
    expect(normalizeLinqNumber('')).toBeUndefined();
    expect(normalizeLinqNumber('not a number')).toBeUndefined();
    // Past E.164's 15-digit ceiling.
    expect(normalizeLinqNumber('+1234567890123456')).toBeUndefined();
  });
});

describe('link codes', () => {
  it('mints a code in the advertised shape', () => {
    const code = createLinqLinkCode();

    expect(code).toMatch(LINQ_LINK_CODE_PATTERN);
    expect(code).toHaveLength(3 + LINQ_LINK_CODE_LENGTH);
    // No glyphs that are mistyped when read off a screen.
    expect(code.slice(3)).not.toMatch(/[ILO01]/);
  });

  it('keeps the matcher in step with the alphabet it draws from', () => {
    // The pattern spells the alphabet as ranges while the minter walks the
    // string, so pin them together: every mintable glyph matches…
    for (const glyph of LINQ_LINK_CODE_ALPHABET) {
      const sample = `LH-${glyph.repeat(LINQ_LINK_CODE_LENGTH)}`;
      expect(extractLinqLinkCode(sample), `expected ${JSON.stringify(sample)} to match`).toBe(
        sample,
      );
    }
    // …and none of the excluded ambiguous ones does.
    for (const glyph of 'ILO01') {
      const sample = `LH-${glyph.repeat(LINQ_LINK_CODE_LENGTH)}`;
      expect(extractLinqLinkCode(sample), `expected ${JSON.stringify(sample)} not to match`).toBe(
        undefined,
      );
    }
  });

  it('draws each symbol uniformly over the alphabet', () => {
    // `byte % 31` on its own favours the first 8 symbols, so the minter drops
    // any byte past the last whole multiple of the alphabet and draws again.
    const rejected = 256 - (256 % LINQ_LINK_CODE_ALPHABET.length);
    let firstBatch = true;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(LINQ_LINK_CODE_ALPHABET.length - 1);
      if (firstBatch) {
        bytes[0] = rejected;
        firstBatch = false;
      }
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    const code = createLinqLinkCode();

    // The out-of-range byte was dropped rather than mapped, so eight symbols
    // still came out and a second batch had to be drawn to replace it.
    expect(code).toBe(`LH-${LINQ_LINK_CODE_ALPHABET.at(-1)!.repeat(LINQ_LINK_CODE_LENGTH)}`);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });

  it('refuses to mint without a CSPRNG', () => {
    vi.stubGlobal('crypto', undefined);

    expect(() => createLinqLinkCode()).toThrow(/CSPRNG/);
  });

  it('does not repeat across a burst of mints', () => {
    const codes = new Set(Array.from({ length: 200 }, () => createLinqLinkCode()));
    expect(codes.size).toBe(200);
  });

  it('extracts a code from the message a person actually sends', () => {
    const code = createLinqLinkCode();

    expect(extractLinqLinkCode(`hey, linking now ${code}`)).toBe(code);
    // Case-insensitive: a person typing the code by hand still links.
    expect(extractLinqLinkCode(code.toLowerCase())).toBe(code);
    expect(extractLinqLinkCode(`Hi! ${code}.`)).toBe(code);
  });

  it('returns undefined when no code is present', () => {
    expect(extractLinqLinkCode('just saying hello')).toBeUndefined();
    expect(extractLinqLinkCode('')).toBeUndefined();
    expect(extractLinqLinkCode(undefined)).toBeUndefined();
    // A longer token that merely contains the prefix is not a code.
    expect(extractLinqLinkCode('X LH-ABCD2345Z')).toBeUndefined();
  });
});

describe('buildLinqDeepLink', () => {
  it('builds both link schemes off the normalized number', () => {
    const link = buildLinqDeepLink({ number: '+1 (555) 000-2222' });

    expect(link).toEqual({
      imessage: 'imessage:+15550002222',
      number: '+15550002222',
      sms: 'sms:+15550002222',
    });
  });

  it('prefills the one-time code so the inbound message is attributable', () => {
    const code = createLinqLinkCode();
    const link = buildLinqDeepLink({ code, message: 'Link my agent', number: '+15550002222' });

    expect(link!.body).toBe(`Link my agent ${code}`);
    // Both platforms' delimiter, and the body survives URL-encoding.
    expect(link!.sms).toBe(`sms:+15550002222?&body=${encodeURIComponent(`Link my agent ${code}`)}`);
    expect(link!.imessage).toBe(
      `imessage:+15550002222?&body=${encodeURIComponent(`Link my agent ${code}`)}`,
    );
  });

  it('round-trips: what the deep link prefills is what the inbound extractor finds', () => {
    const code = createLinqLinkCode();
    const link = buildLinqDeepLink({ code, number: '+15550002222' });

    expect(link!.body).toBe(code);
    expect(extractLinqLinkCode(link!.body)).toBe(code);
  });

  it('omits the body when there is nothing to prefill, and refuses a bad number', () => {
    expect(buildLinqDeepLink({ number: '+15550002222' })).not.toHaveProperty('body');
    expect(buildLinqDeepLink({ number: 'who knows' })).toBeUndefined();
  });
});
