Desktop Plus v3.6.11-beta1

Upstream: [GitHub Desktop 3.6.11-beta1 release notes](https://github.com/desktop/desktop/releases/tag/release-3.6.11-beta1)

## Changes and improvements:

- [#306] You can now search/filter the "changed files" list in the commit details view. This is especially useful when you want to find a specific file in a large commit.  
  Simply click the search icon (magnifying glass) next to the "N changed files" header.

- [#279] You can now show the number of changed files directly in the repository list, instead of just a blue dot.  
  To enable this, go to "File > Options > Appearance" and check the "Show changed file count in repository list indicators" option.

- [#305] When navigating the commit list with the keyboard, the commit author tooltip will no longer appear automatically after a short delay. Instead, you now need to press the `Space` key to show it.  
  Mouse navigation works exactly as before, the tooltip will appear when hovering over the author name.

- Dropped our custom multi-account implementation in favor of the new upstream feature that does the same thing.  
  The upstream feature works a bit differently from ours, so expect some minor changes in the way repositories are linked to accounts. However, you shouldn't notice any significant differences or regressions. If something seems wrong, please [create a bug report](https://github.com/desktop-plus/desktop-plus/issues/new/choose)!

## Fixes:

- [#304] Fixed minor styling issues in the "Advanced" settings tab.
