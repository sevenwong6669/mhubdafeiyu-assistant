// A committed tool-call step may continue; retries of the same step must not replay speech.
export class SpeechAttempts {
  constructor() { this.current = null; }
  start(frame) {
    const previous = this.current;
    if (typeof frame.attemptId !== 'string' || !Number.isSafeInteger(frame.turn) || !Number.isSafeInteger(frame.step)) return false;
    if (previous && !(previous.committed && previous.finish === 'tool-calls'
      && previous.turn === frame.turn && frame.step === previous.step + 1
      && previous.id !== frame.attemptId)) return false;
    this.current = { id: frame.attemptId, turn: frame.turn, step: frame.step, committed: false, finish: null };
    return true;
  }
  observe(frame) {
    if (!this.current || frame.attemptId !== this.current.id) return;
    if (frame.type === 'chunk' && frame.chunk?.type === 'finish') this.current.finish = frame.chunk.reason?.kind;
    if (frame.type === 'end') this.current.committed = frame.outcome?.kind === 'committed' && frame.outcome.eventType === 'assistant/message';
  }
}
