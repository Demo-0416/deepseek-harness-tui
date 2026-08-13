/**
 * Modal dialog for ask_user_question requests: walks the request's questions
 * one at a time with a selectable option list, multi-select toggling, digit
 * shortcuts, and a free-text "Other" input. Owns keyboard input while
 * visible; Esc cancels the whole request with an empty answer set.
 * @module dsh-tui/tui/components/question-dialog
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { PendingQuestion } from '../../core/controller.ts'
import { useTheme } from '../primitives/themed.tsx'

export interface QuestionDialogProps {
  question: PendingQuestion
  onAnswer: (answer: { answers: AskUserQuestionAnswerItem[] }) => void
}

/** Per-question editing state, reset when advancing to the next question. */
interface ItemState {
  cursor: number
  checked: Set<number>
  /** Free-text input value while in "Other" mode, undefined otherwise. */
  custom: string | undefined
}

function initialItemState(item: AskUserQuestionItem): ItemState {
  const hasOptions = (item.options?.length ?? 0) > 0
  return { cursor: 0, checked: new Set(), custom: hasOptions ? undefined : '' }
}

export function QuestionDialog({ question, onAnswer }: QuestionDialogProps): React.ReactElement {
  const theme = useTheme()
  const questions = question.request.questions
  const [index, setIndex] = useState(0)
  const [collected, setCollected] = useState<AskUserQuestionAnswerItem[]>([])
  const item = questions[index] ?? { id: 'unknown', question: '' }
  const [state, setState] = useState<ItemState>(() => initialItemState(item))

  const options = item.options ?? []
  // The virtual "Other" row sits after the real options.
  const otherIndex = options.length
  const rowCount = options.length + 1

  const commit = (answer: AskUserQuestionAnswerItem): void => {
    const answers = [...collected, answer]
    const nextIndex = index + 1
    if (nextIndex < questions.length) {
      const next = questions[nextIndex]
      setCollected(answers)
      setIndex(nextIndex)
      if (next !== undefined) setState(initialItemState(next))
    } else {
      onAnswer({ answers })
    }
  }

  useInput((input, key) => {
    if (key.escape) {
      if (state.custom !== undefined && options.length > 0) {
        setState({ ...state, custom: undefined })
      } else {
        onAnswer({ answers: [] })
      }
      return
    }

    // Free-text mode: the editor owns printable input.
    if (state.custom !== undefined) {
      if (key.return) {
        const text = state.custom.trim()
        if (text !== '') commit({ id: item.id, selected: [], custom: text })
        return
      }
      if (key.backspace || key.delete) {
        setState({ ...state, custom: state.custom.slice(0, -1) })
        return
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setState({ ...state, custom: state.custom + input })
      }
      return
    }

    if (key.upArrow) {
      setState({ ...state, cursor: (state.cursor + rowCount - 1) % rowCount })
      return
    }
    if (key.downArrow) {
      setState({ ...state, cursor: (state.cursor + 1) % rowCount })
      return
    }
    const digit = Number.parseInt(input, 10)
    if (!Number.isNaN(digit) && digit >= 1 && digit <= rowCount) {
      const target = digit - 1
      if (target === otherIndex) {
        setState({ ...state, cursor: target, custom: '' })
      } else if (item.multiSelect === true) {
        const checked = new Set(state.checked)
        if (checked.has(target)) checked.delete(target)
        else checked.add(target)
        setState({ ...state, cursor: target, checked })
      } else {
        const label = options[target]?.label
        if (label !== undefined) commit({ id: item.id, selected: [label] })
      }
      return
    }
    if (input === ' ' && item.multiSelect === true && state.cursor < otherIndex) {
      const checked = new Set(state.checked)
      if (checked.has(state.cursor)) checked.delete(state.cursor)
      else checked.add(state.cursor)
      setState({ ...state, checked })
      return
    }
    if (key.return) {
      if (state.cursor === otherIndex) {
        setState({ ...state, custom: '' })
        return
      }
      if (item.multiSelect === true) {
        const picked = state.checked.size > 0 ? [...state.checked] : [state.cursor]
        const selected = picked
          .sort((a, b) => a - b)
          .map(i => options[i]?.label)
          .filter((label): label is string => label !== undefined)
        commit({ id: item.id, selected })
      } else {
        const label = options[state.cursor]?.label
        if (label !== undefined) commit({ id: item.id, selected: [label] })
      }
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
      <Box>
        <Text color={theme.brand} bold>
          {item.header !== undefined ? `${item.header} ` : ''}
        </Text>
        <Text color={theme.muted}>
          {questions.length > 1 ? `question ${index + 1}/${questions.length}` : ''}
        </Text>
      </Box>
      <Box>
        <Text bold>{item.question}</Text>
      </Box>
      {item.detail !== undefined && item.detail !== '' && (
        <Box marginBottom={options.length > 0 ? 1 : 0}>
          <Text color={theme.muted}>{item.detail}</Text>
        </Box>
      )}
      {state.custom !== undefined ? (
        <Box>
          <Text color={theme.brand}>{'❯ '}</Text>
          <Text>{state.custom}</Text>
          <Text inverse> </Text>
          <Text color={theme.dim}>  (enter to submit{options.length > 0 ? ', esc to go back' : ''})</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {options.map((option, i) => {
            const active = i === state.cursor
            const checked = state.checked.has(i)
            return (
              <Box key={i}>
                <Text color={active ? theme.brand : theme.dim}>{active ? '❯ ' : '  '}</Text>
                {item.multiSelect === true && (
                  <Text color={checked ? theme.success : theme.muted}>{checked ? '[x] ' : '[ ] '}</Text>
                )}
                <Text color={active ? theme.text : theme.muted}>{i + 1}. {option.label}</Text>
                {option.description !== undefined && option.description !== '' && (
                  <Text color={theme.dim}>  {option.description}</Text>
                )}
              </Box>
            )
          })}
          <Box>
            <Text color={state.cursor === otherIndex ? theme.brand : theme.dim}>
              {state.cursor === otherIndex ? '❯ ' : '  '}
            </Text>
            <Text color={state.cursor === otherIndex ? theme.text : theme.muted}>
              {item.multiSelect === true ? `${rowCount}. ` : `${rowCount}. `}Other (type your own)
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.dim}>
              ↑↓ move · 1-{rowCount} pick{item.multiSelect === true ? ' · space toggle' : ''} · enter confirm · esc cancel
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
