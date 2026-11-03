// The words of a list's menus (v1.29, ADR 0050): the common ones from the
// dictionary, the list's own names of its keys, groupings, facets and values
// from the list. Kept apart from `listview.ts`, which does not translate.

import { t } from "../i18n";
import { NO_GROUPS, type ListMenuText } from "./listview";

/** How a list names what its schema has; anything it does not name is shown as its id. */
export interface ListLabels {
  group?: (id: string) => string;
  sort?: (id: string) => string;
  facet?: (id: string) => string;
  value?: (facet: string, value: string) => string;
}

export function listMenuText(labels: ListLabels): ListMenuText {
  return {
    groups: t("list.groups"),
    order: t("list.order"),
    asc: t("list.asc"),
    desc: t("list.desc"),
    collapseAll: t("list.collapseAll"),
    expandAll: t("list.expandAll"),
    all: t("list.all"),
    reset: t("list.reset"),
    group: (id) => (id === NO_GROUPS ? t("list.noGroups") : (labels.group?.(id) ?? id)),
    sort: (id) => labels.sort?.(id) ?? id,
    facet: (id) => labels.facet?.(id) ?? id,
    value: (facet, value) => labels.value?.(facet, value) ?? value,
  };
}
