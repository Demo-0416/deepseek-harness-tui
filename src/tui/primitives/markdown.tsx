/**
 * Markdown rendering for assistant messages: walks marked tokens and renders
 * headings, code blocks, lists, quotes, and inline formatting with theme
 * colors. Inline formatting is handled with a small tokenizer to avoid
 * pulling in a full inline parser.
 * @module dsh-tui/tui/primitives/markdown
 */

import React from 'react'
import { Box, Text } from 'ink'
import { marked, type Token, type Tokens } from 'marked'
import { useTheme } from './themed.tsx'

/** Render inline markdown (bold, italic, code, links) as colored Text spans. */
function Inline({ text }: { text: string }): React.ReactElement {
  const theme = useTheme()
  const parts: React.ReactNode[] = []
  // Tokenize **bold**, *italic*, `code`, [link](url) in one pass.
  const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let key = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) parts.push(text.slice(last, index))
    const token = match[0]
    if (token === undefined) continue
    if (token.startsWith('**')) {
      parts.push(<Text key={key++} bold>{token.slice(2, -2)}</Text>)
    } else if (token.startsWith('`')) {
      parts.push(<Text key={key++} color={theme.code}>{token.slice(1, -1)}</Text>)
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (linkMatch !== null) {
        parts.push(<Text key={key++} color={theme.link}>{linkMatch[1]}</Text>)
      } else {
        parts.push(token)
      }
    } else {
      parts.push(<Text key={key++} italic>{token.slice(1, -1)}</Text>)
    }
    last = index + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <Text>{parts}</Text>
}

/** Render one block-level token. */
function Block({ token, depth }: { token: Token; depth: number }): React.ReactElement {
  const theme = useTheme()
  const indent = '  '.repeat(depth)

  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading
      return (
        <Box marginTop={depth === 0 ? 1 : 0}>
          <Text color={theme.heading} bold={heading.depth <= 2}>
            {indent}{'#'.repeat(heading.depth)} <Inline text={heading.text} />
          </Text>
        </Box>
      )
    }
    case 'paragraph': {
      const paragraph = token as Tokens.Paragraph
      return (
        <Box>
          <Text>
            {indent}<Inline text={paragraph.text} />
          </Text>
        </Box>
      )
    }
    case 'code': {
      const code = token as Tokens.Code
      const lines = code.text.replace(/\n$/, '').split('\n')
      return (
        <Box flexDirection="column" marginLeft={2} borderStyle="single" borderColor={theme.border}>
          {lines.map((line, i) => (
            <Text key={i} color={theme.code}>{line}</Text>
          ))}
        </Box>
      )
    }
    case 'blockquote': {
      const quote = token as Tokens.Blockquote
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.border}>
          {quote.tokens.map((child, i) => <Block key={i} token={child} depth={depth} />)}
        </Box>
      )
    }
    case 'list': {
      const list = token as Tokens.List
      return (
        <Box flexDirection="column">
          {list.items.map((item, i) => (
            <Box key={i} flexDirection="column">
              {item.tokens.map((child, j) => (
                <Box key={j}>
                  <Text color={theme.muted}>{indent}{list.ordered ? `${i + 1}. ` : '• '}</Text>
                  <Block token={child} depth={0} />
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      )
    }
    case 'list_item': {
      const item = token as Tokens.ListItem
      return (
        <Box flexDirection="column">
          {item.tokens.map((child, i) => <Block key={i} token={child} depth={depth} />)}
        </Box>
      )
    }
    case 'hr': {
      return <Text color={theme.border}>{indent}{'─'.repeat(40)}</Text>
    }
    case 'space': {
      return <Box />
    }
    default: {
      const raw = token.raw ?? ''
      if (raw.trim() === '') return <Box />
      return (
        <Box>
          <Text>{indent}<Inline text={raw} /></Text>
        </Box>
      )
    }
  }
}

export interface MarkdownProps {
  text: string
}

export function Markdown({ text }: MarkdownProps): React.ReactElement {
  const tokens = marked.lexer(text)
  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => <Block key={i} token={token} depth={0} />)}
    </Box>
  )
}
