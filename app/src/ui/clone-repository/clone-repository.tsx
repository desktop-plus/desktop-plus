import * as Path from 'path'
import * as React from 'react'
import { Dispatcher } from '../dispatcher'
import {
  getDefaultDirForAccount,
  setDefaultDirForAccount,
} from '../lib/default-dir'
import { Account, AccountAPIType } from '../../models/account'
import { FoldoutType } from '../../lib/app-state'
import {
  IRepositoryIdentifier,
  parseRepositoryIdentifier,
  parseRemote,
  sanitizeCloneName,
} from '../../lib/remote-parsing'
import { findAccountForRemoteURL } from '../../lib/find-account'
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

  /**
   * The persisted state of the CloneGitHubRepository component for
   * the GitHub.com account.
   */
  readonly dotComTabState: IGitHubTabState

  /**
   * The persisted state of the CloneGitHubRepository component for
   * the GitHub Enterprise account.
   */
  readonly enterpriseTabState: IGitHubTabState

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

  readonly selectedAccount: Account | null
}

interface IUrlTabState extends IBaseTabState {
  readonly kind: 'url'
}

/**
 * Persisted state for the CloneGitHubRepository component.
 */
interface IGitHubTabState extends IBaseTabState {
  readonly kind: AccountAPIType

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
}

/** The component for cloning a repository. */
export class CloneRepository extends React.Component<
  ICloneRepositoryProps,
  ICloneRepositoryState
> {
  private checkIsTopMostDialog = isTopMostDialog(
    () => {
      this.validatePath()
      window.addEventListener('focus', this.onWindowFocus)
    },
    () => {
      window.removeEventListener('focus', this.onWindowFocus)
    }
  )

  private getAccountsForTab = memoizeOne(
    (tab: CloneRepositoryTab, accounts: ReadonlyArray<Account>) => {
      const apiType = this.getAccountAPIType(tab)
      if (apiType === 'generic') {
        return []
      }
      return accounts.filter(account => account.apiType === apiType)
    }
  )

  public constructor(props: ICloneRepositoryProps) {
    super(props)

    const defaultDirectory = null

    const initialBaseTabState: IBaseTabState = {
      error: null,
      lastParsedIdentifier: null,
      path: defaultDirectory,
      url: this.props.initialURL || '',
      selectedAccount: null,
    }

    this.state = {
      loading: false,
      dotComTabState: {
        kind: 'dotcom',
        filterText: '',
        selectedItem: null,
        ...initialBaseTabState,
        selectedAccount:
          props.accounts
            .filter(account => account.apiType === 'dotcom')
            .at(0) || null,
      },
      enterpriseTabState: {
        kind: 'enterprise',
        filterText: '',
        selectedItem: null,
        ...initialBaseTabState,
        selectedAccount:
          props.accounts
            .filter(account => account.apiType === 'enterprise')
            .at(0) || null,
      },
      bitbucketTabState: {
        kind: 'bitbucket',
        filterText: '',
        selectedItem: null,
        ...initialBaseTabState,
        selectedAccount:
          props.accounts
            .filter(account => account.apiType === 'bitbucket')
            .at(0) || null,
      },
      gitlabTabState: {
        kind: 'gitlab',
        filterText: '',
        selectedItem: null,
        ...initialBaseTabState,
        selectedAccount:
          props.accounts
            .filter(account => account.apiType === 'gitlab')
            .at(0) || null,
      },
      forgejoTabState: {
        kind: 'forgejo',
        filterText: '',
        selectedItem: null,
        ...initialBaseTabState,
        selectedAccount:
          props.accounts
            .filter(account => account.apiType === 'forgejo')
            .at(0) || null,
      },
      giteaTabState: {
        kind: 'gitea',
        filterText: '',
        selectedItem: null,
        ...initialBaseTabState,
        selectedAccount:
          props.accounts.filter(account => account.apiType === 'gitea').at(0) ||
          null,
      },
      urlTabState: {
        kind: 'url',
        ...initialBaseTabState,
      },
    }

    this.initializePath()
  }

  private getAccountAPIType(
    tab: CloneRepositoryTab
  ): AccountAPIType | 'generic' {
    switch (tab) {
      case CloneRepositoryTab.DotCom:
        return 'dotcom'
      case CloneRepositoryTab.Enterprise:
        return 'enterprise'
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
        assertNever(tab, `Unknown tab: ${tab}`)
    }
  }

  public componentDidUpdate(prevProps: ICloneRepositoryProps) {
    if (prevProps.selectedTab !== this.props.selectedTab) {
      this.validatePath()
    }

    if (prevProps.initialURL !== this.props.initialURL) {
      this.updateUrl(this.props.initialURL || '')
    }

    this.checkIsTopMostDialog(this.props.isTopMost)
  }

  public componentDidMount() {
    const initialURL = this.props.initialURL
    if (initialURL) {
      this.updateUrl(initialURL)
    }

    this.checkIsTopMostDialog(this.props.isTopMost)
  }

  public componentWillUnmount(): void {
    this.checkIsTopMostDialog(false)
  }

  private initializePath = async () => {
    const withDefaultPath = async <T extends IBaseTabState>(
      tabState: T
    ): Promise<T> => ({
      ...tabState,
      path: await getDefaultDirForAccount(tabState.selectedAccount),
    })

    this.setState({
      dotComTabState: await withDefaultPath(this.state.dotComTabState),
      enterpriseTabState: await withDefaultPath(this.state.enterpriseTabState),
      bitbucketTabState: await withDefaultPath(this.state.bitbucketTabState),
      gitlabTabState: await withDefaultPath(this.state.gitlabTabState),
      forgejoTabState: await withDefaultPath(this.state.forgejoTabState),
      giteaTabState: await withDefaultPath(this.state.giteaTabState),
      urlTabState: await withDefaultPath(this.state.urlTabState),
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
      // Tab not found (for example, when starting the app for the first time, without accounts)
      // Emulate clicking on the first available tab. We know there will always be at least 1 tab (CloneRepositoryTab.Generic)
      this.onTabClicked(0)
    }
    return (
      <Dialog
        className="clone-repository"
        title={__DARWIN__ ? 'Clone a Repository' : 'Clone a repository'}
        onSubmit={this.clone}
        onDismissed={this.props.onDismissed}
        loading={this.state.loading}
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

  private getFilteredTabs() {
    return ALL_CLONE_REPO_TABS.filter(
      tab =>
        tab === CloneRepositoryTab.Generic ||
        this.getAccountsForTab(tab, this.props.accounts).length > 0
    )
  }

  private getSelectedTabId() {
    return this.getTabId(this.props.selectedTab)
  }

  private getTabId(tab: CloneRepositoryTab) {
    return `tab-${tab}`
  }

  private getTabName(tab: CloneRepositoryTab) {
    switch (tab) {
      case CloneRepositoryTab.DotCom:
        return 'GitHub.com'
      case CloneRepositoryTab.Enterprise:
        return 'GitHub Enterprise'
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
      loading ||
      error !== null

    return disabled
  }

  private renderFooter() {
    const selectedTab = this.props.selectedTab
    if (
      selectedTab !== CloneRepositoryTab.Generic &&
      !this.getAccountForTab(selectedTab)
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

    if (tab === CloneRepositoryTab.Generic) {
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
    }

    const tabState = this.getGitHubTabState(tab)
    const tabAccounts = this.getAccountsForTab(tab, this.props.accounts)
    const selectedAccount = this.getAccountForTab(tab)

    if (!selectedAccount) {
      return <DialogContent>{this.renderSignIn(tab)}</DialogContent>
    } else {
      const accountState = this.props.apiRepositories.get(selectedAccount)
      const repositories =
        accountState === undefined ? null : accountState.repositories
      const loading = accountState === undefined ? false : accountState.loading

      return (
        <CloneGithubRepository
          path={tabState.path ?? ''}
          account={selectedAccount}
          accounts={tabAccounts}
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
  }

  private onSelectedAccountChanged = (account: Account) => {
    if (this.props.selectedTab !== CloneRepositoryTab.Generic) {
      this.setGitHubTabState(
        { selectedAccount: account },
        this.props.selectedTab
      )
      this.updatePathForAccount(account, this.props.selectedTab)
    }
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
    const path = lastParsedIdentifier
      ? Path.join(defaultDir, lastParsedIdentifier.name)
      : defaultDir
    this.setTabState({ path }, tab, this.validatePath)
  }

  private getAccountForTab(tab: CloneRepositoryTab): Account | null {
    const tabState = this.getTabState(tab)
    return tabState.selectedAccount
  }

  private getGitHubTabState(
    tab: NonGenericCloneRepositoryTab
  ): IGitHubTabState {
    if (tab === CloneRepositoryTab.DotCom) {
      return this.state.dotComTabState
    } else if (tab === CloneRepositoryTab.Enterprise) {
      return this.state.enterpriseTabState
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
    if (tab === CloneRepositoryTab.DotCom) {
      this.setState(
        prevState => ({
          dotComTabState: {
            ...prevState.dotComTabState,
            ...state,
          },
        }),
        callback
      )
    } else if (tab === CloneRepositoryTab.Enterprise) {
      this.setState(
        prevState => ({
          enterpriseTabState: {
            ...prevState.enterpriseTabState,
            ...state,
          },
        }),
        callback
      )
    } else if (tab === CloneRepositoryTab.Bitbucket) {
      this.setState(
        prevState => ({
          bitbucketTabState: {
            ...prevState.bitbucketTabState,
            ...state,
          },
        }),
        callback
      )
    } else if (tab === CloneRepositoryTab.GitLab) {
      this.setState(
        prevState => ({
          gitlabTabState: {
            ...prevState.gitlabTabState,
            ...state,
          },
        }),
        callback
      )
    } else if (tab === CloneRepositoryTab.Forgejo) {
      this.setState(
        prevState => ({
          forgejoTabState: {
            ...prevState.forgejoTabState,
            ...state,
          },
        }),
        callback
      )
    } else if (tab === CloneRepositoryTab.Gitea) {
      this.setState(
        prevState => ({
          giteaTabState: {
            ...prevState.giteaTabState,
            ...state,
          },
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
    tab: NonGenericCloneRepositoryTab
  ): void {
    if (tab === CloneRepositoryTab.DotCom) {
      this.setState(prevState => ({
        dotComTabState: merge(prevState.dotComTabState, tabState),
      }))
    } else if (tab === CloneRepositoryTab.Enterprise) {
      this.setState(prevState => ({
        enterpriseTabState: merge(prevState.enterpriseTabState, tabState),
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
    if (tab === CloneRepositoryTab.Generic) {
      return null
    }
    const signInTitle = __DARWIN__ ? 'Sign In' : 'Sign in'
    const accountName = this.getTabName(tab)
    const action = this.getSignInAction(tab)
    return (
      <CallToAction actionTitle={signInTitle} onAction={action}>
        <div>
          Sign in to your {accountName} account to access your repositories.
        </div>
      </CallToAction>
    )
  }

  private getSignInAction(tab: NonGenericCloneRepositoryTab) {
    const { dispatcher } = this.props
    if (tab === CloneRepositoryTab.DotCom) {
      return () => dispatcher.showDotComSignInDialog()
    } else if (tab === CloneRepositoryTab.Enterprise) {
      return () => dispatcher.showEnterpriseSignInDialog()
    } else if (tab === CloneRepositoryTab.Bitbucket) {
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

  private onFilterTextChanged = (filterText: string) => {
    if (this.props.selectedTab !== CloneRepositoryTab.Generic) {
      this.setGitHubTabState({ filterText }, this.props.selectedTab)
    }
  }

  private onSelectionChanged = (selectedItem: IAPIRepository | null) => {
    if (this.props.selectedTab !== CloneRepositoryTab.Generic) {
      this.setGitHubTabState({ selectedItem }, this.props.selectedTab)
      this.updateUrl(selectedItem === null ? '' : selectedItem.clone_url)
    }
  }

  private validatePath = async () => {
    const tabState = this.getSelectedTabState()
    const { path, url, error, selectedAccount } = tabState
    const isDefaultPath =
      (await getDefaultDirForAccount(selectedAccount)) === path
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
  private async resolveCloneInfo(): Promise<IAPIRepositoryCloneInfo | null> {
    const { url, lastParsedIdentifier } = this.getSelectedTabState()

    if (url.endsWith('.wiki.git')) {
      return { url }
    }

    const account = await findAccountForRemoteURL(url, this.props.accounts)
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

    const { path } = this.getSelectedTabState()

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

    const cloneInfo = await this.resolveCloneInfo()
    if (!cloneInfo) {
      const error = new Error(
        `We couldn't find that repository. Check that you are logged in, the network is accessible, and the URL or repository alias are spelled correctly.`
      )
      this.setState({ loading: false })
      this.setSelectedTabState({ error })
      return
    }

    const { url, defaultBranch } = cloneInfo

    this.props.dispatcher.closeFoldout(FoldoutType.Repository)
    try {
      this.cloneImpl(url.trim(), path, defaultBranch)
    } catch (e) {
      log.error(`CloneRepository: clone failed to complete to ${path}`, e)
      this.setState({ loading: false })
      this.setSelectedTabState({ error: e })
    }
  }

  private cloneImpl(url: string, path: string, defaultBranch?: string) {
    const { selectedAccount } = this.getSelectedTabState()
    this.props.dispatcher.clone(url, path, { defaultBranch })
    this.props.onDismissed()

    setDefaultDirForAccount(Path.resolve(path, '..'), selectedAccount)
  }

  private onWindowFocus = () => {
    // Verify the path after focus has been regained in
    // case the directory or directory contents has been
    // created/removed/altered while the user wasn't in-app.
    this.validatePath()
  }
}
