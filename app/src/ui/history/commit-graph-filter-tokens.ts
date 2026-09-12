export type TAuthorTokenState = 'valid' | 'invalid' | 'pending'

export type TFilterToken =
  | { kind: 'query'; value: string; start: number; end: number }
  | {
      kind: 'author'
      name: string
      delimiter: string
      value: string
      start: number
      end: number
      state: TAuthorTokenState
      isEdited: boolean
    }

const authorTokenRegExp = /(?:^|\s)author:(\S*)/

export const tokenValueClassNames: Record<TAuthorTokenState, string> = {
  valid: 'token-value',
  invalid: 'token-value-invalid',
  pending: 'token-value-pending',
}

export function parseFilterTokens(
  text: string,
  emailSet: ReadonlySet<string>,
  caretOffset: number | null
): ReadonlyArray<TFilterToken> {
  const tokens: Array<TFilterToken> = []

  const regex = new RegExp(authorTokenRegExp.source, 'g')

  let cursor = 0
  let match: RegExpExecArray | null = null

  while ((match = regex.exec(text)) !== null) {
    const tokenEnd = match.index + match[0].length
    const tokenStart = tokenEnd - match[1].length - 'author:'.length

    if (tokenStart > cursor) {
      tokens.push({
        kind: 'query',
        value: text.substring(cursor, tokenStart),
        start: cursor,
        end: tokenStart,
      })
    }

    const value = match[1]
    const isEdited = caretOffset !== null && tokenEnd === caretOffset
    const isLastToken = regex.lastIndex === text.length

    let state: TAuthorTokenState

    if (isEdited && !isLastToken) {
      state = 'pending'
    } else if (emailSet.has(value.toLowerCase())) {
      state = 'valid'
    } else if (isLastToken) {
      state = 'pending'
    } else {
      state = 'invalid'
    }

    tokens.push({
      kind: 'author',
      name: 'author',
      delimiter: ':',
      value,
      start: tokenStart,
      end: tokenEnd,
      state,
      isEdited,
    })

    cursor = tokenEnd
  }

  if (cursor < text.length) {
    tokens.push({
      kind: 'query',
      value: text.substring(cursor),
      start: cursor,
      end: text.length,
    })
  }

  return tokens
}

export function buildSearchResult(tokens: ReadonlyArray<TFilterToken>) {
  const authorEmails = new Set<string>()

  const queryParts: Array<string> = []

  for (const token of tokens) {
    if (token.kind === 'query') {
      queryParts.push(token.value)
    } else if (token.value === '') {
      // A bare `author:` with no email is not a complete filter token so it
      // remains part of the search query, just like it did before the
      // token-based submit.
      queryParts.push(token.name + token.delimiter)
    } else {
      authorEmails.add(token.value.toLowerCase())
    }
  }

  const query = queryParts.join(' ').replace(/\s+/g, ' ').trim()

  return { query, authorEmails }
}
