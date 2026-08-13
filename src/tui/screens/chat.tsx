/**
 * The chat screen: message stream, approval overlay, composer, and status
 * bar. Subscribes to the per-session SessionStore and the controller.
 * @module dsh-tui/tui/screens/chat
 */

import React, { useMemo, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from 'ink'
import type { TuiController } from '../../core/controller.ts'
import type { SessionStore } from '../../core/session-store.ts'
import type { SessionSnapshot } from '../../core/types.ts'
import { ChatNodeView } from '../components/message.tsx'
import { StatusBar } from '../components/status-bar.tsx'
import { ApprovalDialog } from '../components/approval-dialog.tsx'
import { QuestionDialog } from '../components/question-dialog.tsx'
import { Editor } from '../primitives/editor.tsx'
import { ThemedText, useTheme } from '../primitives/themed.tsx'

/** How many trailing nodes to render (windowed until a virtual list lands). */
const WINDOW = 100

function useSnapshot(store: SessionStore | undefined): SessionSnapshot | undefined {
  return useSyncExternalStore(
    useMemo(() => (store === undefined ? (() => () => {}) : store.subscribe.bind(store)), [store]),
    useMemo(() => (store === undefined ? (() => undefined) : store.getSnapshot.bind(store)), [store]),
  )
}

export interface ChatScreenProps {
  controller: TuiController
  model: string
}

export function ChatScreen({ controller, model }: ChatScreenProps): React.ReactElement {
  const theme = useTheme()
  const store = controller.sessionStore
  const snapshot = useSnapshot(store)
  const [history, setHistory] = React.useState<string[]>([])

  const pendingApproval = controller.getState().approvals[0]
  const pendingQuestion = controller.getState().question

  useInput((input, key) => {
    if (pendingApproval !== undefined || pendingQuestion !== undefined) return // dialogs own input
    if (key.ctrl && input === 'c') {
      if (snapshot?.status === 'running') {
        controller.cancel()
      } else {
        void controller.quit()
      }
    }
  })

  if (snapshot === undefined) {
    return (
      <Box padding={1}>
        <ThemedText token="muted">starting…</ThemedText>
      </Box>
    )
  }

  const visible = snapshot.nodes.slice(-WINDOW)
  const hidden = snapshot.nodes.length - visible.length

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column">
        {hidden > 0 && (
          <Box>
            <Text color={theme.dim}>── ↑ {hidden} earlier messages ──</Text>
          </Box>
        )}
        {visible.map((node, i) => (
          <Box key={`${node.kind}-${i}`} marginY={node.kind === 'user-message' || node.kind === 'assistant' ? 0 : 0}>
            <ChatNodeView node={node} />
          </Box>
        ))}
      </Box>

      {pendingApproval !== undefined && (
        <Box marginTop={1}>
          <ApprovalDialog approval={pendingApproval} onAnswer={(id, outcome) => controller.answerApproval(id, outcome)} />
        </Box>
      )}

      {pendingQuestion !== undefined && (
        <Box marginTop={1}>
          <QuestionDialog question={pendingQuestion} onAnswer={answer => controller.answerQuestion(answer)} />
        </Box>
      )}

      <Box marginTop={1} borderStyle="single" borderColor={theme.border}>
        <Editor
          onSubmit={text => {
            controller.send(text)
            setHistory(h => [...h, text])
          }}
          onCancel={() => {
            if (snapshot.status === 'running') controller.cancel()
            else void controller.quit()
          }}
          history={history}
          disabled={pendingApproval !== undefined || pendingQuestion !== undefined}
          placeholder="send a message, / for commands, ctrl+c to cancel"
        />
      </Box>

      <StatusBar snapshot={snapshot} model={snapshot.model ?? model} cwd={process.cwd()} />
    </Box>
  )
}
