export type EvidenceLevel = 'confirmed' | 'inferred' | 'editorial'
export type SourceStatus = 'live' | 'deleted' | 'local-artifact'
export type ArchitectureLayerId =
  | 'business-entry'
  | 'ai-applications'
  | 'knowledge-assets'
  | 'data-governance'
  | 'source-systems'
export type ArchitecturePositionId =
  | ArchitectureLayerId
  | 'capability-connection'
  | 'runtime-governance'

export interface EvidenceMark {
  readonly level: EvidenceLevel
  readonly sourceIds: readonly string[]
  readonly rationale: string
}

export interface Claim {
  readonly text: string
  readonly evidence: EvidenceMark
}

export interface PipelineStep {
  readonly label: string
  readonly detail: Claim
}

export interface InterviewQuestion {
  readonly question: string
  readonly answer: string
}

export interface ProjectContent {
  readonly id: number
  readonly slug: string
  readonly anchor: string
  readonly title: string
  readonly subtitle: string
  readonly thesis: Claim
  readonly businessProblem: Claim
  readonly primaryPositions: readonly ArchitecturePositionId[]
  readonly layerTouchpoints: readonly ArchitectureLayerId[]
  readonly upstream: readonly string[]
  readonly downstream: readonly string[]
  readonly pipeline: readonly PipelineStep[]
  readonly feedbackLoop: Claim
  readonly misconception: Claim
  readonly interviewQuestions: readonly InterviewQuestion[]
}

export interface SourceRecord {
  readonly id: string
  readonly title: string
  readonly url?: string
  readonly status: SourceStatus
  readonly publisher: string
  readonly purpose: string
}

export interface SiteContent {
  readonly hero: {
    readonly kicker: string
    readonly title: string
    readonly summary: string
    readonly confirmedFact: Claim
  }
  readonly architecture: {
    readonly layers: readonly { readonly id: ArchitectureLayerId; readonly label: string; readonly description: string; readonly relatedProjectIds: readonly number[] }[]
    readonly capabilityConnection: {
      readonly id: 'capability-connection'
      readonly label: string
      readonly description: string
      readonly relatedProjectIds: readonly number[]
    }
    readonly runtimeGovernance: {
      readonly id: 'runtime-governance'
      readonly label: string
      readonly description: string
      readonly relatedProjectIds: readonly number[]
    }
    readonly feedbackLoop: Claim
  }
  readonly evolution: readonly { readonly range: string; readonly label: string; readonly description: string }[]
  readonly projects: readonly ProjectContent[]
  readonly sources: readonly SourceRecord[]
}
