Desktop Plus v3.6.7-beta3

Upstream: [GitHub Desktop 3.6.7-beta3 release notes](https://github.com/desktop/desktop/releases/tag/release-3.6.7-beta3)

## Changes and improvements:

- [#282] You can now use a folder tree view instead of the default plain file list. Thank you @AyhamAl-Ali for your contribution!  
  To enable it, click the toggle button in the Changes tab.

- The app currently has 2 view-mode toggles (in the Changes and History tabs). Since most people have a clear preference and don't need to switch between views constantly, you can now hide those toggles to reclaim some space in the UI.  
  To hide the toggles, select "View > Hide View-Mode Toggles" from the menu bar.

- [#271] The popups showing details about a commit's author now only appear when hovering over the author's name, instead of when hovering over the entire commit.

- [#286] Show a friendly error message when the app is unable to store the account token due to a missing keyring service.

## Fixes:

- [#285] Fixed an issue where the commit list could remain filtered after the searchbox was cleared, causing the results to be incorrectly filtered.
