import { Repository } from './repository'
import { CloneRepositoryOptions } from './clone-options'
import { Branch } from './branch'
import { Commit, CommitOneLine, ICommitContext } from './commit'
import { WorkingDirectoryFileChange } from './status'
import { IStashEntry } from './stash-entry'
import { IRemote } from './remote'

/** A remote to push to instead of the one tracked by the current branch. */
export interface IPushTarget {
  readonly remote: IRemote

  /** Whether the current branch should track the pushed branch from now on */
  readonly setUpstream: boolean
}

/** The types of actions that can be retried. */
export enum RetryActionType {
  Push = 1,
  Pull,
  Fetch,
  Clone,
  Checkout,
  Merge,
  Rebase,
  CherryPick,
  CreateBranchForCherryPick,
  Squash,
  Reorder,
  DiscardChanges,
  StashChanges,
  ResetAndPull,
  PopStash,
  CherryPickToBranches,
}

/** The retriable actions and their associated data. */
export type RetryAction =
  | { type: RetryActionType.Push; repository: Repository }
  | {
      type: RetryActionType.Push
      repository: Repository
      pushTarget: IPushTarget
    }
  | { type: RetryActionType.Pull; repository: Repository }
  | { type: RetryActionType.Fetch; repository: Repository }
  | {
      type: RetryActionType.Clone
      name: string
      url: string
      path: string
      options: CloneRepositoryOptions
    }
  | {
      type: RetryActionType.Checkout
      repository: Repository
      branch: Branch
    }
  | {
      type: RetryActionType.Merge
      repository: Repository
      currentBranch: string
      theirBranch: Branch
    }
  | {
      type: RetryActionType.Rebase
      repository: Repository
      baseBranch: Branch
      targetBranch: Branch
    }
  | {
      type: RetryActionType.CherryPick
      repository: Repository
      targetBranch: Branch
      commits: ReadonlyArray<CommitOneLine>
      sourceBranch: Branch | null
    }
  | {
      type: RetryActionType.CherryPickToBranches
      repository: Repository
      targetBranches: ReadonlyArray<Branch>
      commits: ReadonlyArray<CommitOneLine>
      sourceBranch: Branch | null
    }
  | {
      type: RetryActionType.CreateBranchForCherryPick
      repository: Repository
      targetBranchName: string
      startPoint: string | null
      noTrackOption: boolean
      commits: ReadonlyArray<CommitOneLine>
      sourceBranch: Branch | null
    }
  | {
      type: RetryActionType.Squash
      repository: Repository
      toSquash: ReadonlyArray<Commit>
      squashOnto: Commit
      lastRetainedCommitRef: string | null
      commitContext: ICommitContext
    }
  | {
      type: RetryActionType.Reorder
      repository: Repository
      commitsToReorder: ReadonlyArray<Commit>
      beforeCommit: Commit | null
      lastRetainedCommitRef: string | null
    }
  | {
      type: RetryActionType.DiscardChanges
      repository: Repository
      files: ReadonlyArray<WorkingDirectoryFileChange>
    }
  | {
      type: RetryActionType.StashChanges
      repository: Repository
      files: ReadonlyArray<WorkingDirectoryFileChange>
    }
  | { type: RetryActionType.ResetAndPull; repository: Repository }
  | {
      type: RetryActionType.PopStash
      repository: Repository
      stashEntry: IStashEntry
      keepStash: boolean
    }
