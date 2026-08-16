type JsonRecord = Record<string, unknown>;

const STEP_FIELDS: Record<string, readonly string[]> = {
  goto: ['action', 'path', 'timeoutMs'],
  click: ['action', 'selector', 'timeoutMs'],
  expectVisible: ['action', 'selector', 'timeoutMs'],
  expectText: ['action', 'selector', 'value', 'timeoutMs'],
  waitFor: ['action', 'timeoutMs'],
};

export const DEFAULT_JOURNEY_DEFINITION = {
  name: 'Landing page renders',
  steps: [
    { action: 'goto', path: '/' },
    { action: 'expectVisible', selector: 'body' },
  ],
} as const;

export const DEFAULT_JOURNEY_JSON = JSON.stringify(DEFAULT_JOURNEY_DEFINITION, null, 2);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, maxLength = 500) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function hasOnlyFields(value: JsonRecord, allowed: readonly string[]) {
  const allowlist = new Set(allowed);
  return Object.keys(value).every((key) => allowlist.has(key));
}

export function validateJourneyJson(raw: string, targetUrl: string) {
  let journey: unknown;
  try { journey = JSON.parse(raw); }
  catch { return 'Journey JSON is invalid.'; }

  if (!isRecord(journey) || !hasOnlyFields(journey, ['name', 'steps'])) return 'Journey must contain only name and steps.';
  if (!isBoundedText(journey.name, 120)) return 'Journey name must be between 1 and 120 characters.';
  if (!Array.isArray(journey.steps) || journey.steps.length < 2 || journey.steps.length > 20) return 'Journey requires between 2 and 20 steps.';

  let targetOrigin: string;
  try { targetOrigin = new URL(targetUrl).origin; }
  catch { return 'Enter a valid target URL before defining the journey.'; }

  let hasInteraction = false;
  let hasAssertion = false;
  for (const [index, candidate] of journey.steps.entries()) {
    const position = index + 1;
    if (!isRecord(candidate) || typeof candidate.action !== 'string' || !STEP_FIELDS[candidate.action]) return `Journey step ${position} has an unsupported action.`;
    if (!hasOnlyFields(candidate, STEP_FIELDS[candidate.action])) return `Journey step ${position} contains unsupported fields.`;

    const timeout = candidate.timeoutMs;
    const timeoutMinimum = candidate.action === 'waitFor' ? 50 : 100;
    const timeoutMaximum = candidate.action === 'waitFor' ? 2_000 : 15_000;
    if (candidate.action === 'waitFor' && timeout === undefined) return `Journey step ${position} requires timeoutMs.`;
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < timeoutMinimum || timeout > timeoutMaximum)) {
      return `Journey step ${position} timeoutMs must be an integer between ${timeoutMinimum} and ${timeoutMaximum}.`;
    }

    if (candidate.action === 'goto') {
      if (!isBoundedText(candidate.path)) return `Journey step ${position} requires a path.`;
      try {
        if (new URL(candidate.path as string, targetOrigin).origin !== targetOrigin) return `Journey step ${position} must stay on the target origin.`;
      } catch { return `Journey step ${position} contains an invalid path.`; }
      hasInteraction = true;
    } else if (candidate.action === 'click') {
      if (!isBoundedText(candidate.selector)) return `Journey step ${position} requires a selector.`;
      hasInteraction = true;
    } else if (candidate.action === 'expectVisible') {
      if (!isBoundedText(candidate.selector)) return `Journey step ${position} requires a selector.`;
      hasAssertion = true;
    } else if (candidate.action === 'expectText') {
      if (!isBoundedText(candidate.selector) || !isBoundedText(candidate.value)) return `Journey step ${position} requires a selector and expected value.`;
      hasAssertion = true;
    }
  }

  if (!hasInteraction) return 'Journey requires a same-origin goto or safe click step.';
  if (!hasAssertion) return 'Journey requires an expectVisible or expectText assertion.';
  return '';
}
