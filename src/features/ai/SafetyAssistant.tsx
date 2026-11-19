import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SafetyScope, SafetySnapshot } from '../../../supabase/functions/_shared/safetyIntelligenceContracts'
import { Alert, Button, Card, Icon, PageHeader, Spinner, Textarea } from '../../components/ui'
import { cn } from '../../lib/utils'
import { createAiSession, getAiSession, listAiSessions, sendSafetyCopilotMessage } from './aiService'
import { AssistantConversation, assistantStarterPrompts } from './assistantConversation'
import { AnswerEvidence, AnswerSections } from './AnswerEvidence'

export function SafetyAssistant({ client, scope, snapshot, canViewKnowledge = false }: {
  client: SupabaseClient
  scope: SafetyScope
  snapshot?: SafetySnapshot
  canViewKnowledge?: boolean
}) {
  const queryClient = useQueryClient()
  const conversation = useMemo(() => {
    const prefix = ['ai-conversations', scope.userId, scope.organizationId]
    const storage = {
      getItem: (key: string) => window.localStorage.getItem(key),
      setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
      removeItem: (key: string) => window.localStorage.removeItem(key),
    }
    return new AssistantConversation({
      list: () => queryClient.fetchQuery({ queryKey: [...prefix, 'list'], queryFn: () => listAiSessions(client), staleTime: 0, retry: false }),
      create: () => createAiSession(client),
      read: (id) => queryClient.fetchQuery({ queryKey: [...prefix, id], queryFn: () => getAiSession(client, id), staleTime: 0, retry: false }),
      send: (id, prompt) => sendSafetyCopilotMessage(client, id, prompt),
    }, storage, `sentinel-ai-session:${scope.organizationId}:${scope.userId}`)
  }, [client, queryClient, scope.userId, scope.organizationId])
  const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot, conversation.getSnapshot)
  const messageList = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const list = messageList.current
    list?.scrollTo({ top: list.scrollHeight,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }, [state.messages.length, state.busy])
  useEffect(() => {
    void conversation.load()
    const refresh = () => { void conversation.load() }
    window.addEventListener('incident-records-updated', refresh)
    return () => {
      window.removeEventListener('incident-records-updated', refresh)
      conversation.dispose()
      queryClient.removeQueries({ queryKey: ['ai-conversations', scope.userId, scope.organizationId] })
      queryClient.removeQueries({ queryKey: ['ai-evidence', scope.userId, scope.organizationId] })
    }
  }, [conversation, queryClient, scope.userId, scope.organizationId])
  const disabled = state.busy || state.loading

  return <section id="safety-intelligence-assistant" aria-labelledby="safety-assistant-title" className="grid gap-5">
    <PageHeader
      eyebrow="Safety copilot"
      title="AI Safety Assistant"
      titleId="safety-assistant-title"
      description="Ask about the operational records and approved QHSE knowledge you can access. Advice is advisory, not an official safety decision."
      actions={
        <>
          {canViewKnowledge && (
            <Button variant="outline" size="sm" onClick={() => { window.location.hash = '#knowledge' }}>
              <Icon name="knowledge" size={15} />
              QHSE Knowledge
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => void conversation.newChat()}>
            <Icon name="plus" size={15} />
            New chat
          </Button>
        </>
      }
    />

    <details className="rounded-card border border-line bg-surface px-4 py-3 text-sm text-muted">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-foreground [&::-webkit-details-marker]:hidden">
        <Icon name="lock" size={15} className="text-brand" />
        What this assistant can access
      </summary>
      <div className="mt-2 grid gap-1.5">
        <p>Approved, current QHSE knowledge documents you are permitted to read are searched automatically and cited when used. Drafts, expired, archived and restricted documents are excluded.</p>
        <p>Private, bounded conversation history. Read-only operational evidence; human review required.</p>
      </div>
    </details>

    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand/10 text-brand">
              <Icon name="chatBot" size={17} />
            </span>
            <div>
              <h2 className="font-display text-base font-semibold text-foreground">Conversation</h2>
              <p className="text-xs text-muted">Private, bounded, and advisory.</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
            <Icon name="lock" size={13} />
            Private · Advisory
          </span>
        </div>

        {(state.storageError || state.error) && (
          <div className="grid gap-2 border-b border-line px-5 py-3">
            {state.storageError && <Alert tone="danger">{state.storageError}</Alert>}
            {state.error && <Alert tone="danger">{state.error}</Alert>}
          </div>
        )}

        <div
          ref={messageList}
          className="flex h-[clamp(360px,52vh,620px)] flex-col gap-4 overflow-y-auto p-5 [scrollbar-gutter:stable]"
          aria-label="Conversation messages"
          aria-live="polite"
          aria-busy={disabled}
        >
          {state.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted" role="status">
              <Spinner size={16} fill="currentColor" />
              Loading your private conversation…
            </div>
          ) : !state.messages.length && (
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
                <Icon name="aiAssistant" size={18} />
              </span>
              <div className="max-w-2xl rounded-2xl border border-line bg-surface-soft p-4">
                <h3 className="font-display text-base font-semibold text-foreground">How can I help you review safety today?</h3>
                <p className="mt-1 text-sm text-muted">Ask about reported patterns, incidents, corrective actions or approved QHSE procedures you can access. Missing evidence will be acknowledged.</p>
                <p className="mt-2 text-xs text-muted">Choose a suggested prompt or ask your own question.</p>
              </div>
            </div>
          )}

          {state.messages.map((message) => (
            <article
              key={message.id}
              className={cn(
                'max-w-[94%] rounded-2xl border p-4',
                message.role === 'user' ? 'ml-auto border-brand/20 bg-brand/5' : 'border-line bg-surface-soft',
              )}
            >
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-brand">
                {message.role === 'user' ? 'You' : <><Icon name="aiAssistant" size={14} />Safety Copilot · Advisory</>}
              </div>
              {message.role === 'assistant' && message.evidence?.presentation
                ? <AnswerSections evidence={message.evidence} />
                : <p className="whitespace-pre-wrap text-sm text-foreground">{message.content}</p>}
              {message.role === 'assistant' && message.evidence && !message.evidence.presentation
                && <p className="mt-2 text-xs text-muted">Older answer: original text retained. Structured sections were not saved; citations below come only from validated server metadata.</p>}
              {message.role === 'assistant' && (message.evidence
                ? <AnswerEvidence client={client} scope={scope} evidence={message.evidence} />
                : <p className="mt-2 text-xs text-muted">Validated evidence metadata is unavailable for this answer. No source links are inferred from its text.</p>)}
              {message.status === 'failed' && <p className="mt-2 text-xs text-danger">Request failed. No assistant answer was saved for this turn.</p>}
              {message.status === 'pending' && <p className="mt-2 text-xs text-caution">Completion not yet recorded. Refresh conversations to check the request status.</p>}
            </article>
          ))}

          {state.busy && (
            <div role="status" className="flex items-center gap-2 text-sm text-muted">
              <Spinner size={14} fill="currentColor" />
              Processing your request…
            </div>
          )}
        </div>

        <form className="grid gap-2 border-t border-line p-4" onSubmit={(event) => { event.preventDefault(); void conversation.send() }}>
          <label htmlFor="safety-assistant-question" className="text-xs font-medium text-muted">Your question</label>
          <div className="flex items-end gap-2">
            <Textarea
              ref={composer}
              id="safety-assistant-question"
              rows={2}
              maxLength={4_000}
              value={state.draft}
              disabled={disabled || state.stopped}
              onChange={(event) => conversation.setDraft(event.target.value)}
              placeholder="Ask about your authorized operational data or approved procedures…"
              className="min-h-[52px] min-w-0 flex-1 resize-y"
            />
            <Button
              type="submit"
              size="icon"
              aria-label="Send question"
              title="Send question"
              className="shrink-0"
              disabled={disabled || state.stopped || !state.draft.trim()}
            >
              <Icon name="arrowRight" size={18} />
            </Button>
          </div>
          <p className="text-[11px] text-muted">{state.draft.length}/4,000 · Human review required</p>
        </form>
      </Card>

      <aside className="grid content-start gap-5 lg:sticky lg:top-4" aria-label="Conversation tools">
        <Card className="p-5" aria-labelledby="assistant-suggestions-title">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand/10 text-brand">
              <Icon name="aiAssistant" size={16} />
            </span>
            <h2 id="assistant-suggestions-title" className="font-display text-base font-semibold text-foreground">Suggested prompts</h2>
          </div>
          <p className="mt-1 text-sm text-muted">A starting point for your safety review.</p>
          <div className="mt-4 grid gap-2">
            {assistantStarterPrompts(snapshot).map((prompt) => (
              <button
                type="button"
                key={prompt}
                disabled={disabled || state.stopped}
                onClick={() => {
                  conversation.setDraft(prompt)
                  composer.current?.focus()
                }}
                className="flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-sm text-foreground transition-colors hover:border-brand/40 hover:bg-brand/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Icon name="chatBot" size={15} className="mt-0.5 text-brand" />
                <span>{prompt}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-muted">Suggestions start a question—not a canned answer. Nothing is sent until you choose Send.</p>
        </Card>

        <Card className="p-5">
          <details>
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
              <Icon name="history" size={17} className="text-brand" />
              Your conversations
              <span className="ml-auto text-xs font-normal text-muted">{state.sessions.length}</span>
            </summary>
            <div className="mt-3 grid gap-2" aria-label="Your private conversations">
              <Button variant="outline" size="sm" disabled={disabled} onClick={() => void conversation.load()}>
                <Icon name="refresh" size={14} />
                Refresh conversations
              </Button>
              {!state.sessions.length && !state.loading && <p className="text-sm text-muted">No conversations available.</p>}
              {state.sessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  disabled={disabled}
                  aria-pressed={state.selectedId === session.id}
                  onClick={() => void conversation.open(session.id)}
                  className={cn(
                    'grid gap-0.5 rounded-xl border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    state.selectedId === session.id ? 'border-brand/40 bg-brand/5' : 'border-line hover:bg-surface-soft',
                  )}
                >
                  <strong className="truncate font-medium text-foreground">{session.title}</strong>
                  <small className="text-[11px] text-muted">{new Date(session.updated_at).toLocaleString()}</small>
                </button>
              ))}
              <p className="text-[11px] text-muted">Showing up to 50 recent conversations. Private chats expire 30 days after creation. Context is bounded; this is not permanent memory.</p>
            </div>
          </details>
        </Card>
      </aside>
    </div>
  </section>
}
