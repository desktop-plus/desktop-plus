/** How far repositories are indented under their group header */
export type RepositoryGroupIndentation = 'none' | 'small' | 'medium' | 'large'

/** Every repository group indentation, keyed for `getEnum` and `parseEnumValue` */
export const RepositoryGroupIndentations: Record<
  string,
  RepositoryGroupIndentation
> = {
  None: 'none',
  Small: 'small',
  Medium: 'medium',
  Large: 'large',
}

export const defaultRepositoryGroupIndentation: RepositoryGroupIndentation =
  'none'

/** How group headers stand out from the repositories in the repository list */
export type RepositoryGroupHeaderStyle =
  | 'default'
  | 'emphasized'
  | 'shaded'
  | 'divider'
  | 'accent'
  | 'guides'

/** Every repository group header style, keyed for `getEnum` and `parseEnumValue` */
export const RepositoryGroupHeaderStyles: Record<
  string,
  RepositoryGroupHeaderStyle
> = {
  Default: 'default',
  Emphasized: 'emphasized',
  Shaded: 'shaded',
  Divider: 'divider',
  Accent: 'accent',
  Guides: 'guides',
}

export const defaultRepositoryGroupHeaderStyle: RepositoryGroupHeaderStyle =
  'default'
