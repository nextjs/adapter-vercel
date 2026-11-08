package main

import (
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/dlclark/regexp2"
)

type compiledSegment struct {
	literal  *string
	regexp   *regexp2.Regexp
	globstar bool
}

type functionMatcher struct {
	alternatives [][]compiledSegment
	negate       bool
	legacy       *regexp2.Regexp
}

func compileFunctionMatcher(rule functionRule) functionMatcher {
	compile := func(source string) *regexp2.Regexp {
		// JavaScript regexes here have no /u flag: both patterns and input use
		// UTF-16 code units, including the two halves of an astral character.
		if strings.ContainsFunc(source, func(r rune) bool { return r > 0xffff }) {
			var units strings.Builder
			for _, r := range source {
				if r > 0xffff {
					hi, lo := utf16.EncodeRune(r)
					for _, unit := range []rune{hi, lo} {
						units.WriteString(`\u`)
						for shift := 12; shift >= 0; shift -= 4 {
							units.WriteByte("0123456789abcdef"[(unit>>shift)&15])
						}
					}
				} else {
					units.WriteRune(r)
				}
			}
			source = units.String()
		}
		r, err := regexp2.Compile(source, regexp2.ECMAScript)
		check(err)
		r.MatchTimeout = time.Second
		return r
	}
	m := functionMatcher{negate: rule.Negate}
	if rule.Segments == nil {
		m.legacy = compile(rule.Regexp)
		return m
	}
	for _, parts := range rule.Segments {
		compiled := make([]compiledSegment, len(parts))
		for i, part := range parts {
			if part == nil {
				compiled[i].globstar = true
			} else if part.Literal != nil {
				compiled[i].literal = part.Literal
			} else {
				compiled[i].regexp = compile(part.Regexp)
			}
		}
		m.alternatives = append(m.alternatives, compiled)
	}
	return m
}

var functionPathSeparator = regexp.MustCompile(`/+`)

// Follow minimatch.matchOne over its already-parsed tokens, rather than its
// lossy whole-path makeRe() conversion. Globstars never swallow dot segments.
func (m functionMatcher) match(source string) (bool, error) {
	if m.legacy != nil {
		return matchJSRegexp(m.legacy, source)
	}
	file := functionPathSeparator.Split(source, -1)
	for _, pattern := range m.alternatives {
		var matchOne func(int, int) (bool, error)
		matchOne = func(fi, pi int) (bool, error) {
			for fi < len(file) && pi < len(pattern) {
				part, name := pattern[pi], file[fi]
				if part.globstar {
					for j := fi; j < len(file); j++ {
						if pi+1 < len(pattern) {
							matched, err := matchOne(j, pi+1)
							if err != nil || matched {
								return matched, err
							}
						}
						if strings.HasPrefix(file[j], ".") {
							return false, nil
						}
					}
					return pi+1 == len(pattern), nil
				}
				if part.literal != nil {
					if *part.literal != name {
						return false, nil
					}
				} else {
					matched, err := matchJSRegexp(part.regexp, name)
					if err != nil || !matched {
						return false, err
					}
				}
				fi++
				pi++
			}
			return (fi == len(file) && pi == len(pattern)) || (pi == len(pattern) && fi == len(file)-1 && file[fi] == ""), nil
		}
		matched, err := matchOne(0, 0)
		if err != nil {
			return false, err
		}
		if matched {
			return !m.negate, nil
		}
	}
	return m.negate, nil
}

func matchJSRegexp(pattern *regexp2.Regexp, value string) (bool, error) {
	if !strings.ContainsFunc(value, func(r rune) bool { return r > 0xffff }) {
		return pattern.MatchString(value)
	}
	units := make([]rune, 0, len(value))
	for _, r := range value {
		if r > 0xffff {
			hi, lo := utf16.EncodeRune(r)
			units = append(units, hi, lo)
		} else {
			units = append(units, r)
		}
	}
	return pattern.MatchRunes(units)
}
