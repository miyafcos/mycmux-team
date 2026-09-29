import { resolveDisplayState, type DashboardCardModel } from "./dashboardModel";
import { stateLabels } from "./stateLabels";

export interface DashboardAttentionSections {
  needsAnswer: DashboardCardModel[];
  needsReview: DashboardCardModel[];
  working: DashboardCardModel[];
  other: DashboardCardModel[];
}

export function groupCardsByAttentionSection(
  cards: readonly DashboardCardModel[],
): DashboardAttentionSections {
  return {
    needsAnswer: cards.filter((card) => (
      stateLabels(resolveDisplayState(card)).attention === "needsAnswer"
    )),
    needsReview: cards.filter((card) => (
      stateLabels(resolveDisplayState(card)).attention === "needsReview"
    )),
    working: cards.filter((card) => {
      const labels = stateLabels(resolveDisplayState(card));
      return labels.attention === null && labels.activity === "working";
    }),
    other: cards.filter((card) => {
      const labels = stateLabels(resolveDisplayState(card));
      return labels.attention === null && labels.activity !== "working";
    }),
  };
}

export function orderCardsByAttentionSection(
  cards: readonly DashboardCardModel[],
): DashboardCardModel[] {
  const sections = groupCardsByAttentionSection(cards);
  return [
    ...sections.needsAnswer,
    ...sections.needsReview,
    ...sections.working,
    ...sections.other,
  ];
}
