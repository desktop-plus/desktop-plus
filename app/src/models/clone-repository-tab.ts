export enum CloneRepositoryTab {
  GitHub = 0,
  Bitbucket,
  GitLab,
  Forgejo,
  Gitea,
  Generic,
}

export const ALL_CLONE_REPO_TABS = Object.values(CloneRepositoryTab).filter(
  v => typeof v === 'number'
)

export const NON_GENERIC_CLONE_REPO_TABS = ALL_CLONE_REPO_TABS.filter(
  v => v !== CloneRepositoryTab.Generic
)

export type NonGenericCloneRepositoryTab =
  typeof NON_GENERIC_CLONE_REPO_TABS[number]
