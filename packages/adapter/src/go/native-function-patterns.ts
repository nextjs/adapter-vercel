import minimatch from 'minimatch';

// makeRe() and match() differ for globstars before dot-prefixed segments in
// minimatch 3. Send its parsed path segments so Go retains match() semantics.
export function encodeFunctionPattern(pattern: string) {
  const matcher = new minimatch.Minimatch(pattern);
  return {
    negate: matcher.negate,
    segments: matcher.set.map((parts: unknown[]) =>
      parts.map((part) =>
        typeof part === 'string'
          ? { literal: part }
          : part instanceof RegExp
            ? { regexp: part.source }
            : null
      )
    ),
  };
}
