import { describe, expect, it } from 'vitest';
import { generateToolbarScript } from './toolbar';

const FEEDBACK_SRC = 'https://vercel.live/_next-live/feedback/feedback.js';
const DEPLOYMENT_ID_EXPR = "'dpl_123'";

interface ScriptElement {
  src: string;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
}

/**
 * Runs a generated toolbar script against a minimal `document` stub and
 * returns the elements it appended, if any.
 */
function runScript(script: string, getCookie: () => string): ScriptElement[] {
  const appended: ScriptElement[] = [];
  const documentStub = {
    get cookie() {
      return getCookie();
    },
    createElement(): ScriptElement {
      return {
        src: '',
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      };
    },
    head: {
      appendChild(element: ScriptElement) {
        appended.push(element);
      },
    },
  };

  new Function('document', script)(documentStub);

  return appended;
}

/** Mimics a sandboxed iframe, where reading `document.cookie` throws. */
function unreadableCookie(): never {
  throw new Error(
    'SecurityError: The document is sandboxed and lacks the "allow-same-origin" flag.'
  );
}

describe('generateToolbarScript', () => {
  it('injects the toolbar in production when the opt-in cookie is set', () => {
    const script = generateToolbarScript(true, false, DEPLOYMENT_ID_EXPR);
    const [element] = runScript(script, () => 'foo=bar; __vercel_toolbar=1');

    expect(element.src).toBe(FEEDBACK_SRC);
    expect(element.attributes).toEqual({
      'data-explicit-opt-in': 'true',
      'data-cookie-opt-in': 'true',
      'data-deployment-id': 'dpl_123',
    });
  });

  it('skips the toolbar in production without the opt-in cookie', () => {
    const script = generateToolbarScript(true, false, DEPLOYMENT_ID_EXPR);

    expect(runScript(script, () => 'foo=bar')).toEqual([]);
  });

  it('skips the toolbar when `document.cookie` cannot be read', () => {
    const script = generateToolbarScript(true, false, DEPLOYMENT_ID_EXPR);
    let appended: ScriptElement[] = [];

    expect(() => {
      appended = runScript(script, unreadableCookie);
    }).not.toThrow();
    expect(appended).toEqual([]);
  });

  it('does not read the cookie outside of production', () => {
    const script = generateToolbarScript(false, true, DEPLOYMENT_ID_EXPR);
    const [element] = runScript(script, unreadableCookie);

    expect(element.src).toBe(FEEDBACK_SRC);
    expect(element.attributes).toEqual({
      'data-explicit-opt-in': 'true',
      'data-deployment-id': 'dpl_123',
    });
  });
});
