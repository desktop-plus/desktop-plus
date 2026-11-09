import * as Path from 'path'
import * as React from 'react'
import { Dispatcher } from '../dispatcher'
import {
  getDefaultDirForAccount,
  setDefaultDirForAccount,
} from '../lib/default-dir'
import {
  Account,
  AccountAPIType,
  IAccountIdentity,
  isDotComAccount,
  isEnterpriseAccount,
  isSameAccount,
} from '../../models/account'
import { FoldoutType } from '../../lib/app-state'
import {
  IRepositoryIdentifier,
  parseRepositoryIdentifier,
  parseRemote,
  sanitizeCloneName,
} from '../../lib/remote-parsing'
import { resolveURLCloneInfo } from '../../lib/clone-info'
import { API, IAPIRepository, IAPIRepositoryCloneInfo } from '../../lib/api'
import { getForgejoNameForAccounts } from '../../lib/forgejo-name'
import { Dialog, DialogError, DialogFooter, DialogContent } from '../dialog'
import { TabBar } from '../tab-bar'
import {
  ALL_CLONE_REPO_TABS,
  CloneRepositoryTab,
  NonGenericCloneRepositoryTab,
} from '../../models/clone-repository-tab'
import { CloneGenericRepository } from './clone-generic-repository'
import { CloneGithubRepository } from './clone-github-repository'
import { assertNever } from '../../lib/fatal-error'
import { CallToAction } from '../lib/call-to-action'
import { IAccountRepositories } from '../../lib/stores/api-repositories-store'
import { merge } from '../../lib/merge'
import { ClickSource } from '../lib/list'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { showOpenDialog, showSaveDialog } from '../main-process-proxy'
import { readdir } from 'fs/promises'
import { isTopMostDialog } from '../dialog/is-top-most'
import memoizeOne from 'memoize-one'
import { groupAccountsByHost } from '../../lib/group-accounts-by-host'
import { SignInResult } from '../../lib/stores/sign-in-store'
import { LinkButton } from '../lib/link-button'
import { Row } from '../lib/row'
import {
  canonicalMutationPath,
  isRepositoryAffectedByAssistedCommit,
} from '../../lib/git/repository-operation'

interface ICloneRepositoryProps {
  readonly dispatcher: Dispatcher
  readonly onDismissed: () => void

  readonly accounts: ReadonlyArray<Account>

  /** The initial URL or `owner/name` shortcut to use. */
  readonly initialURL: string | null

  /** The currently select tab. */
  readonly selectedTab: CloneRepositoryTab

  /** Called when the user selects a tab. */
  readonly onTabSelected: (tab: CloneRepositoryTab) => void

  /**
   * The account last picked in the GitHub tab, or null to use the first
   * signed-in account in picker order.
   */
  readonly selectedAccount: IAccountIdentity | null

  /**
   * A map keyed on a user account (GitHub.com or GitHub Enterprise)
   * containing an object with repositories that the authenticated
   * user has explicit permission (:read, :write, or :admin) to access
   * as well as information about whether the list of repositories
   * is currently being loaded or not.
   *
   * If a currently signed in account is missing from the map that
   * means that the list of accessible repositories has not yet been
   * loaded. An entry for an account with an empty list of repositories
   * means that no accessible repositories was found for the account.
   *
   * See the ApiRepositoriesStore for more details on loading repositories
   */
  readonly apiRepositories: ReadonlyMap<Account, IAccountRepositories>

  /**
   * Called when the user requests a refresh of the repositories
   * available for cloning.
   */
  readonly onRefreshRepositories: (account: Account) => void

  /** Whether the dialog is the top most in the dialog stack */
  readonly isTopMost: boolean
}

interface ICloneRepositoryState {
  /** Are we currently trying to load the entered repository? */
  readonly loading: boolean

  /** The persisted state of the CloneGitHubRepository component. */
  readonly gitHubTabState: IGitHubTabState

  /**
   * The persisted state of the CloneGitHubRepository component for
   * the Bitbucket account.
   */
  readonly bitbucketTabState: IGitHubTabState

  /**
   * The persisted state of the CloneGitHubRepository component for
   * the GitLab account.
   */
  readonly gitlabTabState: IGitHubTabState

  /**
   * The persisted state of the CloneGitHubRepository component for
   * the Forgejo account.
   */
  readonly forgejoTabState: IGitHubTabState

  /**
   * The persisted state of the CloneGitHubRepository component for
   * the Gitea account.
   */
  readonly giteaTabState: IGitHubTabState

  /**
   * The persisted state of the CloneGenericRepository component.
   */
  readonly urlTabState: IUrlTabState
}

/**
 * Common persisted state for the CloneGitHubRepository and
 * CloneGenericRepository components.
 */
interface IBaseTabState {
  /** The current error if one occurred. */
  readonly error: Error | null

  /**
   * The repository identifier that was last parsed from the user-entered URL.
   */
  readonly lastParsedIdentifier: IRepositoryIdentifier | null

  /** The local path to clone to. */
  readonly path: string | null

  /** The user-entered URL or `owner/name` shortcut. */
  readonly url: string
}

interface IUrlTabState extends IBaseTabState {
  readonly kind: 'urlTabState'
}

/**
 * Persisted state for the CloneGitHubRepository component.
 */
interface IGitHubTabState extends IBaseTabState {
  readonly kind: 'gitHubTabState' | AccountAPIType

  /**
   * The contents of the filter text box used to filter the list of
   * repositories.
   */
  readonly filterText: string

  /**
   * The currently selected repository, or null if no repository
   * is selected.
   */
  readonly selectedItem: IAPIRepository | null

  /**
   * The account picked in a non-GitHub provider tab, or null to use the first
   * account of that provider. Unused by the GitHub tab, which uses the
   * `selectedAccount` prop instead.
   */
  readonly selectedAccount: Account | null
}

/** What to clone, captured when the user starts cloning. */
interface ICloneRequest {
  readonly tab: CloneRepositoryTab
  readonly url: string
  readonly lastParsedIdentifier: IRepositoryIdentifier | null
  readonly path: string | null

  /**
   * The account selected in the GitHub or provider tab, or null when cloning
   * from the URL tab.
   */
  readonly account: Account | null
}

/** The component for cloning a repository. */
export class CloneRepository extends React.Component<
  ICloneRepositoryProps,
  ICloneRepositoryState
> {
  private validatedClonePath:
    | { readonly path: string; readonly canonical: string }
    | undefined
  private cloneDestinationProtected = false

  private checkIsTopMostDialog = isTopMostDialog(
    () => {
      this.validatePath()
      window.addEventListener('focus', this.onWindowFocus)
    },
    () => {
      window.removeEventListener('focus', this.onWindowFocus)
    }
  )

  /** The signed-in accounts in the order the account picker lists them. */
  private getAccountsInPickerOrder = memoizeOne(
    (accounts: ReadonlyArray<Account>) => [
      ...accounts.filter(isDotComAccount),
      ...groupAccountsByHost(accounts.filter(isEnterpriseAccount)).flatMap(
        ([, hostAccounts]) => hostAccounts
      ),
    ]
  )

  private getAccountsForTab = memoizeOne(
    (tab: CloneRepositoryTab, accounts: ReadonlyArray<Account>) => {
      if (tab === CloneRepositoryTab.GitHub) {
        return this.getAccountsInPickerOrder(accounts)
      }
      const apiType = this.getAccountAPIType(tab)
      if (apiType === 'generic') {
        return []
      }
      return groupAccountsByHost(
        accounts.filter(account => account.apiType === apiType)
      ).flatMap(([, hostAccounts]) => hostAccounts)
    }
  )

  private mounted = false

  /**
   * The account whose repositories the GitHub tab's selection and filter
   * belong to. See `resetGitHubTabSelectionIfAccountChanged`.
   */
  private gitHubTabAccount: Account | null

  public constructor(props: ICloneRepositoryProps) {
    super(props)

    const defaultDirectory = null

    const initialBaseTabState: IBaseTabState = {
      error: null,
      lastParsedIdentifier: null,
      path: defaultDirectory,
      url: this.props.initialURL || '',
    }

    const initialProviderTabState = {
      filterText: '',
      selectedItem: null,
      selectedAccount: null,
      ...initialBaseTabState,
    }

    this.state = {
      loading: false,
      gitHubTabState: {
        kind: 'gitHubTabState',
        filterText: '',
        selectedItem: null,
        selectedAccount: null,
        ...initialBaseTabState,
      },
      bitbucketTabState: { kind: 'bitbucket', ...initialProviderTabState },
      gitlabTabState: { kind: 'gitlab', ...initialProviderTabState },
      forgejoTabState: { kind: 'forgejo', ...initialProviderTabState },
      giteaTabState: { kind: 'gitea', ...initialProviderTabState },
      urlTabState: {
        kind: 'urlTabState',
        ...initialBaseTabState,
      },
    }

    this.gitHubTabAccount = this.getSelectedAccount()
    this.initializePath()
  }

  private getAccountAPIType(
    tab: CloneRepositoryTab
  ): AccountAPIType | 'generic' {
    switch (tab) {
      case CloneRepositoryTab.GitHub:
        // The GitHub tab lists both GitHub.com and GitHub Enterprise accounts.
        return 'dotcom'
      case CloneRepositoryTab.Bitbucket:
        return 'bitbucket'
      case CloneRepositoryTab.GitLab:
        return 'gitlab'
      case CloneRepositoryTab.Forgejo:
        return 'forgejo'
      case CloneRepositoryTab.Gitea:
        return 'gitea'
      case CloneRepositoryTab.Generic:
        return 'generic'
      default:
        return assertNever(tab, `Unknown tab: ${tab}`)
    }
  }

  public componentDidUpdate(prevProps: ICloneRepositoryProps) {
    if (prevProps.selectedTab !== this.props.selectedTab) {
      this.validatePath()
    }

    if (prevProps.initialURL !== this.props.initialURL) {
      this.updateUrl(this.props.initialURL || '')
    }

    // The effective account can also change without the picker, e.g. when the
    // selected account is signed out while the dialog is open.
    if (
      prevProps.accounts !== this.props.accounts ||
      prevProps.selectedAccount !== this.props.selectedAccount
    ) {
      this.resetGitHubTabSelectionIfAccountChanged(this.getSelectedAccount())
    }

    const protectedDestination = this.isCloneDestinationProtected()
    if (this.cloneDestinationProtected !== protectedDestination) {
      this.cloneDestinationProtected = protectedDestination
      this.validatePath()
    }
    this.checkIsTopMostDialog(this.props.isTopMost)
  }

  public componentDidMount() {
    this.mounted = true
    const initialURL = this.props.initialURL
    if (initialURL) {
      this.updateUrl(initialURL)
    }

    this.checkIsTopMostDialog(this.props.isTopMost)
  }

  public componentWillUnmount(): void {
    this.mounted = false
    this.checkIsTopMostDialog(false)
  }

  private initializePath = async () => {
    const withDefaultPath = async <T extends IBaseTabState>(
      tabState: T,
      tab: CloneRepositoryTab
    ): Promise<T> => ({
      ...tabState,
      path: await getDefaultDirForAccount(this.getAccountForTab(tab)),
    })

    const { state } = this
    const Tab = CloneRepositoryTab
    this.setState({
      gitHubTabState: await withDefaultPath(state.gitHubTabState, Tab.GitHub),
      bitbucketTabState: await withDefaultPath(
        state.bitbucketTabState,
        Tab.Bitbucket
      ),
      gitlabTabState: await withDefaultPath(state.gitlabTabState, Tab.GitLab),
      forgejoTabState: await withDefaultPath(
        state.forgejoTabState,
        Tab.Forgejo
      ),
      giteaTabState: await withDefaultPath(state.giteaTabState, Tab.Gitea),
      urlTabState: await withDefaultPath(state.urlTabState, Tab.Generic),
    })

    // Update the local path based on the current url now that we have an
    // initial path
    const selectedTabState = this.getSelectedTabState()
    this.updateUrl(selectedTabState.url)
  }

  public render() {
    const { error } = this.getSelectedTabState()
    const filteredTabs = this.getFilteredTabs()
    const selectedTabBarIndex = filteredTabs.indexOf(this.props.selectedTab)
    if (selectedTabBarIndex === -1) {
      // The selected provider tab has no accounts (e.g. they were signed out).
      // Emulate clicking on the first tab, which is always available.
      this.onTabClicked(0)
    }
    return (
      <Dialog
        className="clone-repository"
        title={__DARWIN__ ? 'Clone a Repository' : 'Clone a repository'}
        onSubmit={this.clone}
        onDismissed={this.props.onDismissed}
        loading={this.state.loading}
        disabled={this.state.loading}
      >
        <TabBar
          onTabClicked={this.onTabClicked}
          selectedIndex={selectedTabBarIndex}
        >
          {filteredTabs.map(tab => (
            <span key={tab} id={this.getTabId(tab)}>
              {this.getTabName(tab)}
            </span>
          ))}
        </TabBar>

        {error ? <DialogError>{error.message}</DialogError> : null}

        <div role="tabpanel" aria-labelledby={this.getSelectedTabId()}>
          {this.renderActiveTab()}
        </div>

        {this.renderFooter()}
      </Dialog>
    )
  }

  /**
   * The tabs shown in the tab bar: the GitHub and URL tabs, and the tab of
   * every other provider with a signed-in account.
   */
  private getFilteredTabs() {
    return ALL_CLONE_REPO_TABS.filter(
      tab =>
        tab === CloneRepositoryTab.GitHub ||
        tab === CloneRepositoryTab.Generic ||
        this.getAccountsForTab(tab, this.props.accounts).length > 0
    )
  }

  private getSelectedTabId() {
    return this.getTabId(this.props.selectedTab)
  }

  private getTabId(tab: CloneRepositoryTab) {
    switch (tab) {
      case CloneRepositoryTab.GitHub:
        return 'github-tab'
      case CloneRepositoryTab.Generic:
        return 'url-tab'
      default:
        return `tab-${tab}`
    }
  }

  private getTabName(tab: CloneRepositoryTab) {
    switch (tab) {
      case CloneRepositoryTab.GitHub:
        return 'GitHub'
      case CloneRepositoryTab.Bitbucket:
        return 'Bitbucket'
      case CloneRepositoryTab.GitLab:
        return 'GitLab'
      case CloneRepositoryTab.Forgejo:
        return getForgejoNameForAccounts(
          this.getAccountsForTab(tab, this.props.accounts)
        )
      case CloneRepositoryTab.Gitea:
        return 'Gitea'
      case CloneRepositoryTab.Generic:
        return 'URL'
      default:
        return assertNever(tab, `Unknown tab: ${tab}`)
    }
  }

  private checkIfCloningDisabled = () => {
    const tabState = this.getSelectedTabState()
    const { error, url, path } = tabState
    const { loading } = this.state

    const disabled =
      url.length === 0 ||
      path == null ||
      path.length === 0 ||
      this.isCloneDestinationProtected() ||
      loading ||
      error !== null

    return disabled
  }

  private isCloneDestinationProtected(): boolean {
    const { path } = this.getSelectedTabState()
    if (path === null) {
      return false
    }
    return isRepositoryAffectedByAssistedCommit(
      this.validatedClonePath?.path === path
        ? this.validatedClonePath.canonical
        : path
    )
  }

  private renderFooter() {
    const selectedTab = this.props.selectedTab
    if (
      selectedTab !== CloneRepositoryTab.Generic &&
      this.getAccountForTab(selectedTab) === null
    ) {
      return null
    }

    const disabled = this.checkIfCloningDisabled()

    return (
      <DialogFooter>
        <OkCancelButtonGroup okButtonText="Clone" okButtonDisabled={disabled} />
      </DialogFooter>
    )
  }

  private onTabClicked = (index: number) => {
    const tab = this.getFilteredTabs()[index]
    this.props.onTabSelected(tab)
  }

  private onPathChanged = (path: string) => {
    this.setSelectedTabState({ path }, this.validatePath)
  }

  private renderActiveTab() {
    const tab = this.props.selectedTab

    switch (tab) {
      case CloneRepositoryTab.Generic:
        const tabState = this.state.urlTabState
        return (
          <CloneGenericRepository
            path={tabState.path ?? ''}
            url={tabState.url}
            onPathChanged={this.onPathChanged}
            onUrlChanged={this.updateUrl}
            onChooseDirectory={this.onChooseDirectory}
          />
        )

      case CloneRepositoryTab.GitHub:
      case CloneRepositoryTab.Bitbucket:
      case CloneRepositoryTab.GitLab:
      case CloneRepositoryTab.Forgejo:
      case CloneRepositoryTab.Gitea: {
        const tabState = this.getGitHubTabState(tab)
        const selectedAccount = this.getAccountForTab(tab)

        if (selectedAccount === null) {
          return <DialogContent>{this.renderSignIn(tab)}</DialogContent>
        }

        const accountState = this.props.apiRepositories.get(selectedAccount)
        const repositories =
          accountState === undefined ? null : accountState.repositories
        const loading =
          accountState === undefined ? false : accountState.loading

        return (
          <CloneGithubRepository
            path={tabState.path ?? ''}
            account={selectedAccount}
            accounts={this.getAccountsForTab(tab, this.props.accounts)}
            selectedItem={tabState.selectedItem}
            onSelectionChanged={this.onSelectionChanged}
            onPathChanged={this.onPathChanged}
            onChooseDirectory={this.onChooseDirectory}
            repositories={repositories}
            loading={loading}
            onRefreshRepositories={this.props.onRefreshRepositories}
            filterText={tabState.filterText}
            onFilterTextChanged={this.onFilterTextChanged}
            onItemClicked={this.onItemClicked}
            onSelectedAccountChanged={this.onSelectedAccountChanged}
          />
        )
      }
      default:
        return assertNever(tab, `Unknown tab: ${tab}`)
    }
  }

  private onSelectedAccountChanged = (account: Account) => {
    const tab = this.props.selectedTab
    if (tab === CloneRepositoryTab.GitHub) {
      this.onGitHubAccountChanged(account)
    } else if (tab !== CloneRepositoryTab.Generic) {
      if (!isSameAccount(account, this.getAccountForTab(tab))) {
        this.setGitHubTabState(
          { selectedAccount: account, selectedItem: null, filterText: '' },
          tab
        )
        this.updateUrl('')
      }
      this.updatePathForAccount(account, tab)
    }
  }

  private onGitHubAccountChanged(account: Account) {
    this.resetGitHubTabSelectionIfAccountChanged(account)
    this.props.dispatcher.changeCloneRepositoriesAccount(account)
    this.updatePathForAccount(account, CloneRepositoryTab.GitHub)
  }

  /**
   * Point the path field of the given tab to the last clone location used
   * with the given account, keeping the repository name entered by the user.
   */
  private updatePathForAccount = async (
    account: Account,
    tab: CloneRepositoryTab
  ) => {
    const defaultDir = await getDefaultDirForAccount(account)
    const { lastParsedIdentifier } = this.getTabState(tab)
    const safeName = lastParsedIdentifier
      ? sanitizeCloneName(lastParsedIdentifier.name)
      : null
    const path = safeName ? Path.join(defaultDir, safeName) : defaultDir
    this.setTabState({ path }, tab, this.validatePath)
  }

  /**
   * Reset the GitHub tab's selection when it's about to show another
   * account's repositories.
   *
   * The selected repository was listed for the previous account, so it
   * mustn't carry over to an account that may not be able to access it, or
   * that is on another host. The account is tracked rather than compared
   * between renders so that picking an account resets the tab only once, even
   * though the picked account also arrives later through props.
   */
  private resetGitHubTabSelectionIfAccountChanged(account: Account | null) {
    const previous = this.gitHubTabAccount
    const changed =
      account === null || previous === null
        ? account !== previous
        : !isSameAccount(account, previous)
    this.gitHubTabAccount = account

    if (changed) {
      this.resetGitHubTabSelection()
    }
  }

  /**
   * Clear the GitHub tab's selected repository, filter text and URL.
   *
   * The filter is cleared as well since the filter list would otherwise
   * select the first match on its own without reporting it, leaving the
   * repository selected but the URL empty.
   */
  private resetGitHubTabSelection() {
    this.setGitHubTabState({ selectedItem: null, filterText: '' })
    if (this.props.selectedTab === CloneRepositoryTab.GitHub) {
      this.updateUrl('')
    } else {
      this.setTabState({ url: '' }, CloneRepositoryTab.GitHub)
    }
  }

  /**
   * The account to browse and clone with in the GitHub tab: the account last
   * picked while it's still signed in, otherwise the first account in picker
   * order. Null when no account is signed in.
   */
  private getSelectedAccount(): Account | null {
    const accounts = this.getAccountsInPickerOrder(this.props.accounts)
    const { selectedAccount } = this.props
    return (
      accounts.find(a => isSameAccount(a, selectedAccount)) ??
      accounts.at(0) ??
      null
    )
  }

  /**
   * The account to browse and clone with in the given tab: see
   * `getSelectedAccount` for the GitHub tab, and the account last picked in
   * a provider tab while it's still signed in, otherwise the provider's first
   * account. Null for the URL tab.
   */
  private getAccountForTab(tab: CloneRepositoryTab): Account | null {
    if (tab === CloneRepositoryTab.GitHub) {
      return this.getSelectedAccount()
    }
    if (tab === CloneRepositoryTab.Generic) {
      return null
    }
    const accounts = this.getAccountsForTab(tab, this.props.accounts)
    const { selectedAccount } = this.getGitHubTabState(tab)
    return (
      accounts.find(a => isSameAccount(a, selectedAccount)) ??
      accounts.at(0) ??
      null
    )
  }

  private getGitHubTabState(
    tab: NonGenericCloneRepositoryTab
  ): IGitHubTabState {
    if (tab === CloneRepositoryTab.GitHub) {
      return this.state.gitHubTabState
    } else if (tab === CloneRepositoryTab.Bitbucket) {
      return this.state.bitbucketTabState
    } else if (tab === CloneRepositoryTab.GitLab) {
      return this.state.gitlabTabState
    } else if (tab === CloneRepositoryTab.Forgejo) {
      return this.state.forgejoTabState
    } else if (tab === CloneRepositoryTab.Gitea) {
      return this.state.giteaTabState
    } else {
      return assertNever(tab, `Unknown tab: ${tab}`)
    }
  }

  private getTabState(tab: CloneRepositoryTab): IBaseTabState {
    if (tab === CloneRepositoryTab.Generic) {
      return this.state.urlTabState
    } else {
      return this.getGitHubTabState(tab)
    }
  }

  private getSelectedTabState(): IBaseTabState {
    return this.getTabState(this.props.selectedTab)
  }

  /**
   * Update the state for the currently selected tab. Note that
   * since the selected tab can be using either IGitHubTabState
   * or IUrlTabState this method can only accept subset state
   * shared between the two types.
   */
  private setSelectedTabState<K extends keyof IBaseTabState>(
    state: Pick<IBaseTabState, K>,
    callback?: () => void
  ) {
    this.setTabState(state, this.props.selectedTab, callback)
  }

  /**
   * Merge the current state with the provided subset of state
   * for the provided tab.
   */
  private setTabState<K extends keyof IBaseTabState>(
    state: Pick<IBaseTabState, K>,
    tab: CloneRepositoryTab,
    callback?: () => void
  ): void {
    if (tab === CloneRepositoryTab.GitHub) {
      this.setState(
        prevState => ({
          gitHubTabState: { ...prevState.gitHubTabState, ...state },
        }),
        callback
      )
    } else if (tab === CloneRepositoryTab.Bitbucket) {
      this.setState(
        prevState => ({
          bitbucketTabState: { ...prevState.bitbucketTabState, ...state },
        }),
        callback
      )
    } else if (tab === CloneRepositoryTab.GitLab) {
      this.setState(
        prevState => ({
          gitlabTabState: { ...prevState.gitlabTabState, ...state },
        }),
        callback
      )
    } else if (tab === CloneRepositoryTab.Forgejo) {
      this.setState(
        prevState => ({
          forgejoTabState: { ...prevState.forgejoTabState, ...state },
        }),
        callback
      )
    } else if (tab === CloneRepositoryTab.Gitea) {
      this.setState(
        prevState => ({
          giteaTabState: { ...prevState.giteaTabState, ...state },
        }),
        callback
      )
    } else if (tab === CloneRepositoryTab.Generic) {
      this.setState(
        prevState => ({
          urlTabState: { ...prevState.urlTabState, ...state },
        }),
        callback
      )
    } else {
      return assertNever(tab, `Unknown tab: ${tab}`)
    }
  }

  private setGitHubTabState<K extends keyof IGitHubTabState>(
    tabState: Pick<IGitHubTabState, K>,
    tab: NonGenericCloneRepositoryTab = CloneRepositoryTab.GitHub
  ): void {
    if (tab === CloneRepositoryTab.GitHub) {
      this.setState(prevState => ({
        gitHubTabState: merge(prevState.gitHubTabState, tabState),
      }))
    } else if (tab === CloneRepositoryTab.Bitbucket) {
      this.setState(prevState => ({
        bitbucketTabState: merge(prevState.bitbucketTabState, tabState),
      }))
    } else if (tab === CloneRepositoryTab.GitLab) {
      this.setState(prevState => ({
        gitlabTabState: merge(prevState.gitlabTabState, tabState),
      }))
    } else if (tab === CloneRepositoryTab.Forgejo) {
      this.setState(prevState => ({
        forgejoTabState: merge(prevState.forgejoTabState, tabState),
      }))
    } else if (tab === CloneRepositoryTab.Gitea) {
      this.setState(prevState => ({
        giteaTabState: merge(prevState.giteaTabState, tabState),
      }))
    } else {
      return assertNever(tab, `Unknown tab: ${tab}`)
    }
  }

  private renderSignIn(tab: CloneRepositoryTab) {
    const signInTitle = __DARWIN__ ? 'Sign In' : 'Sign in'
    if (tab === CloneRepositoryTab.Generic) {
      return null
    }
    if (tab !== CloneRepositoryTab.GitHub) {
      return (
        <CallToAction
          actionTitle={signInTitle}
          onAction={this.getSignInAction(tab)}
        >
          <div>
            Sign in to your {this.getTabName(tab)} account to access your
            repositories.
          </div>
        </CallToAction>
      )
    }
    return (
      <>
        <CallToAction actionTitle={signInTitle} onAction={this.signInDotCom}>
          <div>
            Sign in to your GitHub.com account to access your repositories.
          </div>
        </CallToAction>
        <Row className="sign-in-enterprise">
          <LinkButton onClick={this.signInEnterprise}>
            {__DARWIN__
              ? 'Sign In to GitHub Enterprise'
              : 'Sign in to GitHub Enterprise'}
          </LinkButton>
        </Row>
      </>
    )
  }

  /** Select the account the user signed in to from this dialog. */
  private onSignInResult = (result: SignInResult) => {
    if (result.kind !== 'success') {
      return
    }
    if (this.mounted) {
      this.onGitHubAccountChanged(result.account)
    } else {
      this.props.dispatcher.changeCloneRepositoriesAccount(result.account)
    }
  }

  private getSignInAction(
    tab: Exclude<NonGenericCloneRepositoryTab, CloneRepositoryTab.GitHub>
  ) {
    const { dispatcher } = this.props
    if (tab === CloneRepositoryTab.Bitbucket) {
      return () => dispatcher.showBitbucketSignInDialog()
    } else if (tab === CloneRepositoryTab.GitLab) {
      return () => dispatcher.showGitLabSignInDialog()
    } else if (tab === CloneRepositoryTab.Forgejo) {
      return () => dispatcher.showCodebergSignInDialog()
    } else if (tab === CloneRepositoryTab.Gitea) {
      return () => dispatcher.showGiteaSignInDialog()
    } else {
      return assertNever(tab, `Unknown sign in tab: ${tab}`)
    }
  }

  private signInDotCom = () => {
    this.props.dispatcher.showDotComSignInDialog(this.onSignInResult)
  }

  private signInEnterprise = () => {
    this.props.dispatcher.showEnterpriseSignInDialog(
      undefined,
      this.onSignInResult
    )
  }

  private onFilterTextChanged = (filterText: string) => {
    const tab = this.props.selectedTab
    if (tab !== CloneRepositoryTab.Generic) {
      this.setGitHubTabState({ filterText }, tab)
    }
  }

  private onSelectionChanged = (selectedItem: IAPIRepository | null) => {
    const tab = this.props.selectedTab
    if (tab !== CloneRepositoryTab.Generic) {
      this.setGitHubTabState({ selectedItem }, tab)
    }
    this.updateUrl(selectedItem === null ? '' : selectedItem.clone_url)
  }

  private validatePath = async () => {
    const tabState = this.getSelectedTabState()
    const { path, url, error } = tabState
    const isDefaultPath =
      (await getDefaultDirForAccount(
        this.getAccountForTab(this.props.selectedTab)
      )) === path
    const isURLNotEntered = url === ''

    if (isDefaultPath && isURLNotEntered) {
      if (error) {
        this.setSelectedTabState({ error: null })
      }
    } else {
      const pathValidation = await this.validateClonePath(path)

      // We only care about the result if the path hasn't
      // changed since we went async
      const newTabState = this.getSelectedTabState()
      if (newTabState.path === path) {
        this.setSelectedTabState({ error: pathValidation, path })
      }
    }
  }

  private onChooseDirectory = async () => {
    // We received feedback (#12812) that using the save dialog is confusing on
    // windows due to appearing to require a file selection. This is not the case
    // on mac where it more clearly shows directory creation.
    if (__DARWIN__) {
      return this.onChooseWithSaveDialog()
    }

    return this.onChooseWithOpenDialog()
  }

  private onChooseWithOpenDialog = async (): Promise<string | undefined> => {
    const path = await showOpenDialog({
      properties: ['createDirectory', 'openDirectory'],
    })

    if (path === null) {
      return
    }

    const tabState = this.getSelectedTabState()
    const lastParsedIdentifier = tabState.lastParsedIdentifier
    const safeName = lastParsedIdentifier
      ? sanitizeCloneName(lastParsedIdentifier.name)
      : null
    const directory = safeName ? Path.join(path, safeName) : path

    this.setSelectedTabState(
      { path: directory, error: null },
      this.validatePath
    )

    return directory
  }

  private onChooseWithSaveDialog = async (): Promise<string | undefined> => {
    const tabState = this.getSelectedTabState()

    const path = await showSaveDialog({
      buttonLabel: 'Select',
      nameFieldLabel: 'Clone As:',
      showsTagField: false,
      defaultPath: tabState.path ?? '',
      properties: ['createDirectory'],
    })

    if (path == null) {
      return
    }

    this.setSelectedTabState({ path, error: null }, this.validatePath)

    return path
  }

  private updateUrl = async (url: string) => {
    const parsed = parseRepositoryIdentifier(url)
    const tabState = this.getSelectedTabState()
    const lastParsedIdentifier = tabState.lastParsedIdentifier

    // If there is no path yet, just update the url
    if (tabState.path === null) {
      this.setSelectedTabState({ url }, this.validatePath)
      return
    }

    const safeName = parsed ? sanitizeCloneName(parsed.name) : null

    let newPath: string

    const dirPath = tabState.path
    if (lastParsedIdentifier) {
      if (safeName) {
        newPath = Path.join(Path.dirname(dirPath), safeName)
      } else {
        newPath = Path.dirname(dirPath)
      }
    } else if (safeName) {
      newPath = Path.join(dirPath, safeName)
    } else {
      newPath = dirPath
    }

    this.setSelectedTabState(
      {
        url,
        lastParsedIdentifier: parsed,
        path: newPath,
      },
      this.validatePath
    )
  }

  /** Validate the destination before cloning can create files in it. */
  private async validateClonePath(path: string | null): Promise<null | Error> {
    if (path === null) {
      return new Error(
        'Unable to read path on disk. Please check the path and try again.'
      )
    }

    if (
      __DARWIN__ &&
      Path.basename(Path.resolve(path)).toLowerCase().endsWith('.app')
    ) {
      return new Error(
        'The local path cannot end in .app on macOS. Choose a different folder name to avoid creating an application bundle.'
      )
    }

    try {
      const canonical = await canonicalMutationPath(path)
      if (this.getSelectedTabState().path === path) {
        this.validatedClonePath = { path, canonical }
      }
      if (isRepositoryAffectedByAssistedCommit(canonical)) {
        return new Error(
          'Finish or cancel the assisted commit run before cloning into this directory.'
        )
      }
      const directoryFiles = await readdir(path)

      if (directoryFiles.length === 0) {
        return null
      } else {
        return new Error(
          'This folder contains files. Git can only clone to empty folders.'
        )
      }
    } catch (error) {
      if (error.code === 'ENOTDIR') {
        // path refers to a file or other file system entry
        return new Error(
          'There is already a file with this name. Git can only clone to a folder.'
        )
      }

      if (error.code === 'ENOENT') {
        // Folder does not exist
        return null
      }

      log.error(
        'CloneRepository: Path validation failed. Error: ' + error.message
      )
      return new Error(
        'Unable to read path on disk. Please check the path and try again.'
      )
    }
  }

  /**
   * Lookup the account associated with the clone (if applicable) and resolve
   * the repository alias to the clone URL and the repository default branch,
   * if possible.
   */
  private async resolveCloneInfo(
    request: ICloneRequest
  ): Promise<IAPIRepositoryCloneInfo | null> {
    const { tab, url, lastParsedIdentifier, account } = request

    if (url.endsWith('.wiki.git')) {
      return { url }
    }

    if (tab === CloneRepositoryTab.Generic) {
      return resolveURLCloneInfo(url, this.props.accounts)
    }

    if (lastParsedIdentifier !== null && account !== null) {
      const api = API.fromAccount(account)
      const { owner, name } = lastParsedIdentifier
      // Respect the user's preference if they provided an SSH URL
      const protocol = parseRemote(url)?.protocol

      return api.fetchRepositoryCloneInfo(owner, name, protocol).catch(err => {
        log.error(`Failed to look up repository clone info for '${url}'`, err)
        return { url }
      })
    }

    return { url }
  }

  private onItemClicked = (repository: IAPIRepository, source: ClickSource) => {
    if (source.kind === 'keyboard' && source.event.key === 'Enter') {
      if (this.checkIfCloningDisabled() === false) {
        this.clone()
      }
    }
  }

  private clone = async () => {
    this.setState({ loading: true })

    // Capture what's being cloned before going async, so that changes made
    // while the clone is being prepared can't mix one account's repository
    // with another account.
    const request = this.getCloneRequest()
    const { path } = request

    if (path == null) {
      const error = new Error(`Directory could not be created at this path.`)
      this.setState({ loading: false })
      this.setSelectedTabState({ error })
      return
    }

    const pathError = await this.validateClonePath(path)
    if (pathError !== null) {
      this.setState({ loading: false })
      this.setSelectedTabState({ error: pathError })
      return
    }

    const cloneInfo = await this.resolveCloneInfo(request)
    if (!cloneInfo) {
      const error = new Error(
        `We couldn't find that repository. Check that you are logged in, the network is accessible, and the URL or repository alias are spelled correctly.`
      )
      this.setState({ loading: false })
      this.setSelectedTabState({ error })
      return
    }

    const { url, defaultBranch } = cloneInfo

    const currentPathError = await this.validateClonePath(path)
    if (currentPathError !== null) {
      this.setState({ loading: false })
      this.setSelectedTabState({ error: currentPathError })
      return
    }
    this.props.dispatcher.closeFoldout(FoldoutType.Repository)
    try {
      this.cloneImpl(request, url.trim(), path, defaultBranch)
    } catch (e) {
      log.error(`CloneRepository: clone failed to complete to ${path}`, e)
      this.setState({ loading: false })
      this.setSelectedTabState({ error: e })
    }
  }

  /** Snapshot the selected tab's clone request. */
  private getCloneRequest(): ICloneRequest {
    const tab = this.props.selectedTab
    const { url, lastParsedIdentifier, path } = this.getTabState(tab)
    return {
      tab,
      url,
      lastParsedIdentifier,
      path,
      account: this.getAccountForTab(tab),
    }
  }

  private cloneImpl(
    request: ICloneRequest,
    url: string,
    path: string,
    defaultBranch?: string
  ) {
    const { account } = request
    this.props.dispatcher.clone(
      url,
      path,
      account === null
        ? { defaultBranch }
        : {
            defaultBranch,
            account: { endpoint: account.endpoint, login: account.login },
          }
    )
    this.props.onDismissed()

    setDefaultDirForAccount(Path.resolve(path, '..'), account)
  }

  private onWindowFocus = () => {
    // Verify the path after focus has been regained in
    // case the directory or directory contents has been
    // created/removed/altered while the user wasn't in-app.
    this.validatePath()
  }
}
