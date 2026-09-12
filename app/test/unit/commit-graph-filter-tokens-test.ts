import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  parseFilterTokens,
  buildSearchResult,
  TFilterToken,
} from '../../src/ui/history/commit-graph-filter-tokens'

const emailSet = new Set<string>()

describe('parseFilterTokens', () => {
  describe('basic parsing', () => {
    it('returns empty array for empty string', () => {
      assert.deepEqual(parseFilterTokens('', emailSet, null), [])
    })

    it('returns a single query token for plain text', () => {
      const tokens = parseFilterTokens('hello world', emailSet, null)
      assert.strictEqual(tokens.length, 1)
      assert.strictEqual(tokens[0].kind, 'query')
      assert.strictEqual(tokens[0].value, 'hello world')
    })

    it('parses a single author token', () => {
      const tokens = parseFilterTokens('author:foo@bar.com', emailSet, null)
      assert.strictEqual(tokens.length, 1)
      assert.strictEqual(tokens[0].kind, 'author')
      assert.strictEqual(tokens[0].value, 'foo@bar.com')
    })

    it('parses author token with surrounding text', () => {
      const tokens = parseFilterTokens(
        'hello author:foo@bar.com world',
        emailSet,
        null
      )
      assert.strictEqual(tokens.length, 3)
      assert.strictEqual(tokens[0].kind, 'query')
      assert.strictEqual(tokens[0].value, 'hello ')
      assert.strictEqual(tokens[1].kind, 'author')
      assert.strictEqual(tokens[1].value, 'foo@bar.com')
      assert.strictEqual(tokens[2].kind, 'query')
      assert.strictEqual(tokens[2].value, ' world')
    })
  })

  describe('bare author: handling', () => {
    it('parses bare author: with no email as pending', () => {
      const tokens = parseFilterTokens('author:', emailSet, null)
      assert.strictEqual(tokens.length, 1)
      assert.strictEqual(tokens[0].kind, 'author')
      assert.strictEqual(tokens[0].value, '')
    })

    it('treats text before bare author: as query', () => {
      const tokens = parseFilterTokens('hello author:', emailSet, null)
      assert.strictEqual(tokens.length, 2)
      assert.strictEqual(tokens[0].kind, 'query')
      assert.strictEqual(tokens[0].value, 'hello ')
      assert.strictEqual(tokens[1].kind, 'author')
      assert.strictEqual(tokens[1].value, '')
    })
  })

  describe('token state logic', () => {
    const knownEmail = 'known@example.com'
    const knownEmailSet = new Set([knownEmail])

    it('marks author as valid when email is in set and not last token', () => {
      // Two author tokens so the first is not the last
      const tokens = parseFilterTokens(
        `author:${knownEmail} author:other@example.com`,
        knownEmailSet,
        null
      )
      assert.strictEqual(tokens[0].kind, 'author')
      assert.strictEqual(tokens[0].state, 'valid')
    })

    it('marks author as invalid when email is not in set and not last token', () => {
      const tokens = parseFilterTokens(
        'author:unknown@example.com author:other@example.com',
        knownEmailSet,
        null
      )
      assert.strictEqual(tokens[0].kind, 'author')
      assert.strictEqual(tokens[0].state, 'invalid')
    })

    it('marks last token as valid when email is in set', () => {
      const tokens = parseFilterTokens(
        `author:${knownEmail}`,
        knownEmailSet,
        null
      )
      assert.strictEqual(tokens[0].kind, 'author')
      assert.strictEqual(tokens[0].state, 'valid')
    })

    it('marks last token as pending when email is not in set', () => {
      const tokens = parseFilterTokens(
        'author:unknown@example.com',
        knownEmailSet,
        null
      )
      assert.strictEqual(tokens[0].kind, 'author')
      assert.strictEqual(tokens[0].state, 'pending')
    })

    it('sets isEdited when caret is at the end of the token', () => {
      const text = `author:${knownEmail}`
      const caretOffset = text.length // caret at the very end
      const tokens = parseFilterTokens(text, knownEmailSet, caretOffset)
      assert.strictEqual(tokens[0].kind, 'author')
      assert.strictEqual(tokens[0].isEdited, true)
    })

    it('isEdited not set when caret is elsewhere', () => {
      const text = `author:${knownEmail}`
      const tokens = parseFilterTokens(text, knownEmailSet, 3) // caret in middle
      assert.strictEqual(tokens[0].kind, 'author')
      assert.strictEqual(tokens[0].isEdited, false)
    })

    it('marks as pending when isEdited and not last token', () => {
      // Two tokens, caret at end of first → isEdited + not last → pending
      const text = `author:${knownEmail} author:other@example.com`
      const firstTokenEnd = `author:${knownEmail}`.length
      const tokens = parseFilterTokens(text, knownEmailSet, firstTokenEnd)
      assert.strictEqual(tokens[0].kind, 'author')
      assert.strictEqual(tokens[0].state, 'pending')
      assert.strictEqual(tokens[0].isEdited, true)
    })
  })

  describe('multiple tokens and offsets', () => {
    const knownEmailSet = new Set(['a@b.com', 'c@d.com'])

    it('parses two author tokens separated by a space', () => {
      // The regex (?:^|\s)author: consumes the space before the second token,
      // so the space between them becomes a query token.
      const tokens = parseFilterTokens(
        'author:a@b.com author:c@d.com',
        knownEmailSet,
        null
      )
      assert.strictEqual(tokens.length, 3)
      assert.strictEqual(tokens[0].kind, 'author')
      assert.strictEqual(tokens[0].value, 'a@b.com')
      assert.strictEqual(tokens[1].kind, 'query')
      assert.strictEqual(tokens[1].value, ' ')
      assert.strictEqual(tokens[2].kind, 'author')
      assert.strictEqual(tokens[2].value, 'c@d.com')
    })

    it('parses mixed query and author tokens', () => {
      const tokens = parseFilterTokens(
        'fix author:a@b.com for author:c@d.com',
        knownEmailSet,
        null
      )
      assert.strictEqual(tokens.length, 4)
      assert.strictEqual(tokens[0].kind, 'query')
      assert.strictEqual(tokens[0].value, 'fix ')
      assert.strictEqual(tokens[1].kind, 'author')
      assert.strictEqual(tokens[1].value, 'a@b.com')
      assert.strictEqual(tokens[2].kind, 'query')
      assert.strictEqual(tokens[2].value, ' for ')
      assert.strictEqual(tokens[3].kind, 'author')
      assert.strictEqual(tokens[3].value, 'c@d.com')
    })

    it('matches email case-insensitively', () => {
      const tokens = parseFilterTokens(
        'author:Foo@Bar.com',
        new Set(['foo@bar.com']),
        null
      )
      assert.strictEqual(tokens[0].kind, 'author')
      assert.strictEqual(tokens[0].state, 'valid')
    })

    it('computes correct start and end offsets', () => {
      const text = 'hi author:a@b.com bye'
      const tokens = parseFilterTokens(text, knownEmailSet, null)

      // Query: 'hi ' (0..3)
      assert.strictEqual(tokens[0].start, 0)
      assert.strictEqual(tokens[0].end, 3)

      // Author: 'author:a@b.com' — regex match starts at the space (index 2),
      // but tokenStart is computed back to where 'author:' begins (index 3)
      // tokenEnd = match.index + match[0].length = 2 + 15 = 17
      assert.strictEqual(tokens[1].start, 3)
      assert.strictEqual(tokens[1].end, 17)

      // Query: ' bye' (17..21)
      assert.strictEqual(tokens[2].start, 17)
      assert.strictEqual(tokens[2].end, 21)
    })
  })
})

describe('buildSearchResult', () => {
  function authorToken(
    value: string,
    overrides?: Partial<TFilterToken>
  ): TFilterToken {
    return {
      kind: 'author',
      name: 'author',
      delimiter: ':',
      value,
      start: 0,
      end: 0,
      state: 'valid',
      isEdited: false,
      ...overrides,
    }
  }

  function queryToken(value: string): TFilterToken {
    return { kind: 'query', value, start: 0, end: 0 }
  }

  it('returns empty query and empty email set for empty tokens', () => {
    const result = buildSearchResult([])
    assert.strictEqual(result.query, '')
    assert.strictEqual(result.authorEmails.size, 0)
  })

  it('preserves query tokens as the query string', () => {
    const result = buildSearchResult([queryToken('hello world')])
    assert.strictEqual(result.query, 'hello world')
    assert.strictEqual(result.authorEmails.size, 0)
  })

  it('adds author token value to email set', () => {
    const result = buildSearchResult([authorToken('foo@bar.com')])
    assert.strictEqual(result.query, '')
    assert.ok(result.authorEmails.has('foo@bar.com'))
  })

  it('treats bare author: token as query text', () => {
    const result = buildSearchResult([authorToken('')])
    assert.strictEqual(result.query, 'author:')
    assert.strictEqual(result.authorEmails.size, 0)
  })

  it('builds correct query from mixed tokens', () => {
    const result = buildSearchResult([
      queryToken('fix '),
      authorToken('a@b.com'),
      queryToken(' for '),
      authorToken('c@d.com'),
    ])
    assert.strictEqual(result.query, 'fix for')
    assert.strictEqual(result.authorEmails.size, 2)
    assert.ok(result.authorEmails.has('a@b.com'))
    assert.ok(result.authorEmails.has('c@d.com'))
  })

  it('collapses multiple spaces in query', () => {
    const result = buildSearchResult([
      queryToken('hello'),
      authorToken(''),
      queryToken('  '),
      queryToken('world'),
    ])
    // queryParts: ['hello', 'author:', '  ', 'world']
    // join(' '): 'hello author:   world'
    // replace(/\s+/g, ' '): 'hello author: world'
    assert.strictEqual(result.query, 'hello author: world')
  })

  it('deduplicates emails', () => {
    const result = buildSearchResult([
      authorToken('dup@example.com'),
      queryToken(' '),
      authorToken('dup@example.com'),
    ])
    assert.strictEqual(result.authorEmails.size, 1)
    assert.ok(result.authorEmails.has('dup@example.com'))
  })

  it('lowercases email addresses in output', () => {
    const result = buildSearchResult([authorToken('FOO@BAR.COM')])
    assert.ok(result.authorEmails.has('foo@bar.com'))
  })
})
