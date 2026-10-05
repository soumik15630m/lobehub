/**
 * Linq deep links — how a person *starts* the conversation.
 *
 * LobeHub never opens a chat with a number that has not messaged it first:
 * cold outreach on iMessage is the fastest way to get a carrier number flagged
 * and blocked. The phone link is therefore user-initiated — the product hands
 * the person a `sms:` / `imessage:` link pointing at the agent's Linq number,
 * the person sends it from their own phone, and that first inbound message is
 * what the signed webhook (and the runtime behind it) reacts to.
 *
 * Carrying a one-time **link code** in that message is what makes the inbound
 * attributable: a cold `"hello"` from an unknown handle cannot be matched to an
 * agent, but `"LH-7Q2M4XKP"` can. This module owns the three primitives that
 * flow — the code codec, the E.164 normalization the URI needs, and the URI
 * builders themselves — so every client (web, desktop, mobile, CLI) produces
 * byte-identical links.
 *
 * Deliberately pure: no I/O, no clock, no crypto beyond the CSPRNG used to mint
 * a code. Issuing, storing and expiring a code is the binding flow's job.
 */

import type { CountryCode } from 'libphonenumber-js';
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js';

/** Marker that makes a link code recognizable inside an arbitrary message body. */
export const LINQ_LINK_CODE_PREFIX = 'LH-';

/**
 * Code alphabet without the glyphs people mistype when reading a code off a
 * screen: `I`/`L`, `O`/`0`, and `1`. 31 symbols × 8 chars ≈ 47 bits, which is
 * far beyond what a short-lived, single-use code needs.
 *
 * {@link LINQ_LINK_CODE_PATTERN} spells the same set as ranges; `deep-link.test.ts`
 * pins the two together so they cannot drift.
 */
export const LINQ_LINK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Number of random symbols in a link code (excluding the prefix). */
export const LINQ_LINK_CODE_LENGTH = 8;

/**
 * Matches a link code anywhere in a message, case-insensitively. Boundary
 * anchored so a longer token that merely contains the prefix is not mistaken
 * for a code.
 */
export const LINQ_LINK_CODE_PATTERN = new RegExp(
  `\\b${LINQ_LINK_CODE_PREFIX}[A-HJKMNP-Z2-9]{${LINQ_LINK_CODE_LENGTH}}\\b`,
  'i',
);

/**
 * Bytes at or above this are dropped instead of being folded into a symbol:
 * `byte % 31` alone would make the first eight symbols of the alphabet more
 * likely than the rest, so only whole multiples of the alphabet are mapped.
 */
const UNBIASED_BYTE_LIMIT = 256 - (256 % LINQ_LINK_CODE_ALPHABET.length);

/**
 * Draw random bytes from the platform CSPRNG.
 *
 * `globalThis.crypto` rather than `node:crypto`: this module is the one every
 * client shares, and a static Node builtin import would make it unresolvable
 * for a browser or phone bundler — even for a caller that only wants to build a
 * link, not mint a code.
 */
const randomBytes = (length: number): Uint8Array => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('createLinqLinkCode needs a CSPRNG: `globalThis.crypto` is unavailable');
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
};

/**
 * Mint a link code.
 *
 * Uses the CSPRNG, not `Math.random`: the code is what a person's first inbound
 * message is attributed by, so a guessable code would let one phone number
 * claim another person's link.
 */
export const createLinqLinkCode = (): string => {
  const symbols: string[] = [];
  // Rejection sampling keeps every symbol equally likely; a second batch is
  // only drawn when the first leaves too few usable bytes, which is rare.
  while (symbols.length < LINQ_LINK_CODE_LENGTH) {
    for (const byte of randomBytes(LINQ_LINK_CODE_LENGTH)) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      symbols.push(LINQ_LINK_CODE_ALPHABET[byte % LINQ_LINK_CODE_ALPHABET.length]);
      if (symbols.length === LINQ_LINK_CODE_LENGTH) break;
    }
  }
  return `${LINQ_LINK_CODE_PREFIX}${symbols.join('')}`;
};

/**
 * Pull a link code out of an inbound message body.
 *
 * Returns the normalized (upper-case) code so a person typing the code by hand
 * in lower case still links, or `undefined` when the message carries none.
 */
export const extractLinqLinkCode = (text: string | null | undefined): string | undefined => {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const match = text.match(LINQ_LINK_CODE_PATTERN);
  return match ? match[0].toUpperCase() : undefined;
};

export interface LinqNumberOptions {
  /**
   * Country calling code (digits only, no `+`) assumed when the input carries
   * no `+`. Without it a national-format number is ambiguous, so normalization
   * refuses rather than guessing.
   */
  defaultCountryCode?: string;
}

/**
 * Every country that owns a calling code, taken from the same numbering-plan
 * metadata the parser reads. A calling code is not a country — `+1` is shared
 * by the whole NANP, `+44` by four territories, and `+379` by nobody — so a
 * national-format number is parsed against the plan of some country that owns
 * the code; each of them applies the same trunk prefix and subscriber length.
 */
const COUNTRIES_BY_CALLING_CODE: ReadonlyMap<string, CountryCode[]> = (() => {
  const countriesByCode = new Map<string, CountryCode[]>();
  for (const country of getCountries()) {
    const code = getCountryCallingCode(country);
    const shared = countriesByCode.get(code);
    if (shared) shared.push(country);
    else countriesByCode.set(code, [country]);
  }
  return countriesByCode;
})();

/**
 * The characters people actually paste around a number. Anything else — an
 * `ext. 9`, a stray word — means the string is not a bare destination, and
 * folding the extra digits into the number would address a different one.
 */
const ACCEPTED_NUMBER_FORMAT = /^[+\d][\d\s().\-/]*$/;

/** E.164 caps a full number at 15 digits. */
const E164_MAX_DIGITS = 15;

/**
 * Calling codes the ITU assigns but the numbering-plan metadata carries no plan
 * for. `379` is Vatican City: the code is allocated, the plan is not — numbers
 * there are dialled through the Italian plan — so there is no trunk prefix or
 * length rule to read and the digits are kept as dialled.
 *
 * This is a *metadata-coverage gap*, and the set is closed: it changes only if
 * the parser starts or stops carrying a plan. That is a different thing from
 * the curated list of numbering-plan *rules* this function used to keep, which
 * had to grow with the plans themselves. Everything else the metadata does not
 * know is refused, because a normalized number is a promise we can dial.
 */
const UNMODELED_CALLING_CODES = new Set(['379']);

/**
 * Accept an E.164-shaped value only when it opens with a calling code we know
 * to be assigned-but-unmodeled. Without that gate the fallback would bless any
 * seven-digit string — `+9991234567`, `+0000000` — as a destination.
 */
const asUnmodeledE164 = (value: string): string | undefined => {
  const known = [...UNMODELED_CALLING_CODES].some((code) => value.startsWith(code));
  return known && /^\d{7,15}$/.test(value) ? `+${value}` : undefined;
};

/**
 * Normalize a phone number to E.164, or return `undefined` when it cannot be.
 *
 * Accepts the formatting people actually paste — `+1 (555) 000-2222`,
 * `+1-555-000-2222`, `555 000 2222` with a default country code — and lets the
 * numbering plan decide the trunk prefix and the length. Italy's `06 …` and
 * Côte d'Ivoire's `07 …` keep a zero that is part of the national significant
 * number, a UK `07700 …` has its trunk `0` dropped, and a four-digit Niue
 * number under `+683` stays short because that is what the plan assigns.
 * Refuses rather than guessing.
 */
export const normalizeLinqNumber = (
  raw: string,
  options: LinqNumberOptions = {},
): string | undefined => {
  if (typeof raw !== 'string') return undefined;

  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!ACCEPTED_NUMBER_FORMAT.test(trimmed)) return undefined;

  const digits = trimmed.replaceAll(/\D/g, '');
  if (digits.length > E164_MAX_DIGITS) return undefined;

  // An international number names its own plan. It is parsed as written rather
  // than digit-stripped, so an extension stays visible.
  if (trimmed.startsWith('+')) {
    const parsed = parsePhoneNumberFromString(trimmed);
    if (!parsed) return asUnmodeledE164(digits);
    // `isPossible` — the length the plan allows — rather than `isValid`, which
    // asks whether a carrier would actually assign it: a reserved fixture like
    // `+1 555 000 2222` is still a well-formed destination.
    return !parsed.ext && parsed.isPossible() ? parsed.number : undefined;
  }

  const callingCode = options.defaultCountryCode?.replaceAll(/\D/g, '');
  if (!callingCode || callingCode.length > 3) return undefined;

  const countries = COUNTRIES_BY_CALLING_CODE.get(callingCode);
  if (!countries) return asUnmodeledE164(`${callingCode}${digits}`);

  for (const country of countries) {
    const parsed = parsePhoneNumberFromString(trimmed, country);
    if (!parsed) continue;
    if (!parsed.ext && parsed.isPossible()) return parsed.number;
  }

  return undefined;
};

export interface LinqDeepLinkInput extends LinqNumberOptions {
  /** One-time code the first message should carry, e.g. from {@link createLinqLinkCode}. */
  code?: string;
  /** Optional human-readable line placed before the code. */
  message?: string;
  /** Number the person should text — the agent's own Linq number. */
  number: string;
}

export interface LinqDeepLink {
  /** Prefilled message body; present only when `message` and/or `code` was given. */
  body?: string;
  /** `imessage:` variant — opens Messages directly on Apple devices. */
  imessage: string;
  /** The E.164 number both links point at. */
  number: string;
  /** `sms:` variant — the cross-platform fallback. */
  sms: string;
}

/**
 * Build the pair of links a person taps to start (or resume) a phone link.
 *
 * The `?&body=` delimiter is deliberate rather than sloppy: iOS expects
 * `...&body=`, Android expects `...?body=`, and the doubled delimiter is the
 * form both platforms accept. Returns `undefined` for an unusable number so a
 * caller cannot render a broken link.
 */
export const buildLinqDeepLink = (input: LinqDeepLinkInput): LinqDeepLink | undefined => {
  const number = normalizeLinqNumber(input.number, {
    defaultCountryCode: input.defaultCountryCode,
  });
  if (!number) return undefined;

  const body = [input.message?.trim(), input.code?.trim()].filter(Boolean).join(' ').trim();

  // `encodeURIComponent` keeps the body a single query value — a raw space or
  // `&` would otherwise truncate the prefilled message.
  const suffix = body ? `?&body=${encodeURIComponent(body)}` : '';

  return {
    ...(body ? { body } : {}),
    imessage: `imessage:${number}${suffix}`,
    number,
    sms: `sms:${number}${suffix}`,
  };
};
