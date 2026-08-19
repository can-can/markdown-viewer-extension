import type { BookExportPhase } from '../../../../src/types/book-export';

type BookExportKind = 'docx' | 'epub' | 'pdf';

interface StagePlan {
  phase: BookExportPhase;
  start: number;
  end: number;
  actualCap: number;
}

interface ActiveStageState {
  index: number;
  startedAtMs: number;
  lastDone: number;
  lastTotal: number;
  actualRatio: number;
  halfwayAtMs: number | null;
  halfwayProgress: number | null;
}

const STAGE_PLANS: Record<BookExportKind, StagePlan[]> = {
  docx: [
    { phase: 'fetch', start: 0, end: 0.45, actualCap: 0.9 },
    { phase: 'convert', start: 0.45, end: 0.97, actualCap: 0.92 },
    { phase: 'pack', start: 0.97, end: 1, actualCap: 0.96 },
  ],
  epub: [
    { phase: 'render', start: 0, end: 0.5, actualCap: 0.9 },
    { phase: 'render', start: 0.5, end: 0.9, actualCap: 0.9 },
    { phase: 'convert', start: 0.9, end: 0.97, actualCap: 0.94 },
    { phase: 'pack', start: 0.97, end: 1, actualCap: 0.97 },
  ],
  pdf: [
    { phase: 'render', start: 0, end: 1, actualCap: 0.94 },
  ],
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class BookExportProgressModel {
  private readonly stagePlans: StagePlan[];
  private activeStage: ActiveStageState | null = null;
  private committedRatio = 0;
  private finished = false;

  constructor(kind: BookExportKind) {
    this.stagePlans = STAGE_PLANS[kind];
  }

  onPhaseProgress(phase: BookExportPhase, done: number, total: number, nowMs: number): number {
    if (this.finished) {
      return 1;
    }

    const stageIndex = this.resolveStageIndex(phase, done, total);
    if (stageIndex === -1) {
      return this.tick(nowMs);
    }

    if (!this.activeStage || this.activeStage.index !== stageIndex) {
      const stage = this.stagePlans[stageIndex];
      this.committedRatio = Math.max(this.committedRatio, stage.start);
      this.activeStage = {
        index: stageIndex,
        startedAtMs: nowMs,
        lastDone: done,
        lastTotal: total,
        actualRatio: total > 0 ? clamp(done / total, 0, 1) : 0,
        halfwayAtMs: null,
        halfwayProgress: null,
      };
    } else {
      this.activeStage.lastDone = done;
      this.activeStage.lastTotal = total;
      this.activeStage.actualRatio = total > 0 ? clamp(done / total, 0, 1) : 0;
    }

    const activeStage = this.activeStage;
    if (activeStage.halfwayAtMs === null && activeStage.actualRatio >= 0.5) {
      activeStage.halfwayAtMs = Math.max(1, nowMs - activeStage.startedAtMs);
      activeStage.halfwayProgress = this.actualStageProgress(activeStage.index, activeStage.actualRatio);
    }

    return this.tick(nowMs);
  }

  tick(nowMs: number): number {
    if (this.finished) {
      return 1;
    }
    if (!this.activeStage) {
      return this.committedRatio;
    }

    const actual = this.actualStageProgress(this.activeStage.index, this.activeStage.actualRatio);
    const simulated = this.simulatedStageProgress(this.activeStage, nowMs);
    this.committedRatio = Math.max(this.committedRatio, actual, simulated);
    return this.committedRatio;
  }

  complete(): number {
    this.finished = true;
    this.committedRatio = 1;
    return 1;
  }

  private resolveStageIndex(phase: BookExportPhase, done: number, total: number): number {
    if (!this.activeStage) {
      return this.stagePlans.findIndex((stage) => stage.phase === phase);
    }

    const currentStage = this.stagePlans[this.activeStage.index];
    const sameStageReset = currentStage.phase === phase
      && (done < this.activeStage.lastDone || total !== this.activeStage.lastTotal);
    if (currentStage.phase === phase && !sameStageReset) {
      return this.activeStage.index;
    }

    for (let index = this.activeStage.index + 1; index < this.stagePlans.length; index += 1) {
      if (this.stagePlans[index].phase === phase) {
        const previousStage = this.stagePlans[index - 1];
        if (previousStage) {
          this.committedRatio = Math.max(this.committedRatio, previousStage.end);
        }
        return index;
      }
    }

    return this.activeStage.index;
  }

  private actualStageProgress(stageIndex: number, actualRatio: number): number {
    const stage = this.stagePlans[stageIndex];
    const size = stage.end - stage.start;
    return stage.start + size * clamp(actualRatio, 0, 1) * stage.actualCap;
  }

  private simulatedStageProgress(stageState: ActiveStageState, nowMs: number): number {
    if (stageState.halfwayAtMs === null || stageState.halfwayProgress === null) {
      return this.stagePlans[stageState.index].start;
    }

    const stage = this.stagePlans[stageState.index];
    const halfwayCompletedAtMs = stageState.startedAtMs + stageState.halfwayAtMs;
    const tailRatio = clamp((nowMs - halfwayCompletedAtMs) / stageState.halfwayAtMs, 0, 1);
    return stageState.halfwayProgress + (stage.end - stageState.halfwayProgress) * tailRatio;
  }
}