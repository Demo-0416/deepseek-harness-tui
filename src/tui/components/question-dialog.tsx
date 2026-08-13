/**
 * Question dialog: shown when the agent calls ask_user_question. Renders the
 * pending questions as option menus; arrows move the cursor, space toggles
 * multi-select options, enter answers every question at once, and Esc cancels
 * with an empty answer. Border and accents use the approval token, matching
 * ApprovalDialog.
 * @module dsh-tui/tui/components/question-dialog
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { PendingQuestion } from '../../core/controller.ts'
import { symbols } from '../theme.ts'
import { ThemedText, useTheme } from '../primitives/themed.tsx'

export interface QuestionDialogProps {
  question: PendingQuestion
  onAnswer: (answer: { answers: { id: string; selected: string[]; custom?: string }[] }) => void
}

export function QuestionDialog({ question, onAnswer }: QuestionDialogProps): React.ReactElement {
  const theme = useTheme()
  const questions = question.request.questions
  const [qIndex, setQIndex] = useState(0)
  const [cursors, setCursors] = useState<number[]>(() => questions.map(() => 0))
  const [checked, setChecked] = useState<number[][]>(() => questions.map(() => []))

  const submit = () => {
    const answers = questions.map((q, i) => {
      const options = q.options ?? []
      if (q.multiSelect === true) {
        const selected = (checked[i] ?? [])
          .map(oi => options[oi]?.label)
          .filter((label): label is string => label !== undefined)
        return { id: q.id, selected }
      }
      const label = options[cursors[i] ?? 0]?.label
      return { id: q.id, selected: label === undefined ? [] : [label] }
    })
    onAnswer({ answers })
  }

  useInput((input, key) => {
    if (key.escape) {
      onAnswer({ answers: [] })
      return
    }
    if (key.return) {
      submit()
      return
    }
    const q = questions[qIndex]
    if (q === undefined) return
    const options = q.options ?? []
    if (key.upArrow || key.downArrow) {
      if (options.length === 0) return
      const delta = key.upArrow ? -1 : 1
      setCursors(prev => {
        const next = [...prev]
        const current = next[qIndex] ?? 0
        next[qIndex] = (current + delta + options.length) % options.length
        return next
      })
      return
    }
    if (key.leftArrow || key.rightArrow) {
      if (questions.length < 2) return
      const delta = key.leftArrow ? -1 : 1
      setQIndex(prev => (prev + delta + questions.length) % questions.length)
      return
    }
    if (input === ' ' && q.multiSelect === true) {
      setChecked(prev => {
        const next = [...prev]
        const list = next[qIndex] ?? []
        const current = cursors[qIndex] ?? 0
        next[qIndex] = list.includes(current) ? list.filter(i => i !== current) : [...list, current]
        return next
      })
    }
  })

  const hasMulti = questions.some(q => q.multiSelect === true)
  const many = questions.length > 1

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.approval} paddingX={1}>
      <ThemedText token="approval" bold>
        {symbols.overlayTop} question
      </ThemedText>
      {questions.length === 0 && (
        <Box marginTop={1}>
          <ThemedText token="dim">(no questions)</ThemedText>
        </Box>
      )}
      {questions.map((q, qi) => {
        const focused = qi === qIndex
        const options = q.options ?? []
        return (
          <Box key={q.id} flexDirection="column" marginTop={1}>
            <Text bold>
              {many && (
                <Text color={focused ? theme.approval : theme.dim}>{focused ? '❯' : ' '} </Text>
              )}
              {q.header !== undefined && <Text color={theme.muted}>{q.header} </Text>}
              <Text color={focused ? theme.text : theme.muted}>{q.question}</Text>
              {q.multiSelect === true && <Text color={theme.dim}> (multi-select)</Text>}
            </Text>
            {q.detail !== undefined && (
              <Box>
                <ThemedText token="muted">{q.detail}</ThemedText>
              </Box>
            )}
            {options.length === 0 ? (
              <Box>
                <ThemedText token="dim">(no options)</ThemedText>
              </Box>
            ) : options.map((opt, oi) => {
              const isCursor = focused && oi === (cursors[qi] ?? 0)
              const isChecked = (checked[qi] ?? []).includes(oi)
              return (
                <Box key={opt.label}>
                  <Text color={isCursor ? theme.approval : theme.muted} bold={isCursor}>
                    {q.multiSelect === true ? (isChecked ? '[✓] ' : '[ ] ') : (isCursor ? '(●) ' : '( ) ')}
                  </Text>
                  <Text color={isCursor ? theme.text : theme.muted}>{opt.label}</Text>
                  {opt.description !== undefined && <Text color={theme.dim}> — {opt.description}</Text>}
                </Box>
              )
            })}
          </Box>
        )
      })}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          <Text bold>↑↓</Text> move
          {hasMulti && <Text>  <Text bold>space</Text> toggle</Text>}
          {many && <Text>  <Text bold>←→</Text> question</Text>}
          <Text>  <Text bold>enter</Text> confirm  <Text bold>esc</Text> cancel</Text>
        </Text>
      </Box>
    </Box>
  )
}
