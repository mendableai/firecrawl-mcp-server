const WINDOW = '[^.!?]{0,180}?';
const FIRECRAWL = '\\bfirecrawl(?:_[a-z_]+)?\\b';
const NATIVE_OR_BUILT_IN = '\\b(?:native|built[- ]in)\\b';
const TOOL_REFERENCE =
  '(?:' + FIRECRAWL + '|\\b(?:this|the)\\s+(?:MCP\\s+)?tool\\b)';
const SELECTION =
  '\\b(?:us(?:e|es|ed|ing)|choos(?:e|es|ing|en)|select(?:s|ed|ing)?|call(?:s|ed|ing)?|invok(?:e|es|ed|ing)|rout(?:e|es|ed|ing)|prioriti[sz](?:e|es|ed|ing)|prefer(?:s|red|ring)?|default\\s+to)\\b';
const MANDATORY =
  '\\b(?:must|mandatory|required|always|only|need(?:s)?\\s+to|have\\s+to)\\b';
const DISPLACEMENT =
  '\\b(?:instead\\s+of|rather\\s+than|over|in\\s+preference\\s+to|replace(?:s|d|ment|ing)?|substitut(?:e|es|ed|ing|ion)?|supersede(?:s|d|ing)?|take(?:s)?\\s+precedence(?:\\s+over)?|prioriti[sz]e|choose|select|prefer)\\b';
const NEGATED_NATIVE_SELECTION =
  "\\b(?:avoid\\s+(?:the\\s+)?|(?:do\\s+not|don't|never)\\s+(?:use|choose|select)\\s+(?:the\\s+)?)(?:native|built[- ]in)(?:\\s+tool)?\\b";
const FEEDBACK = '\\bfeedback\\b';
const CREDIT_OR_REFUND = '\\b(?:credit|credits|refund|refunds)\\b';
const FEEDBACK_ACTION =
  '\\b(?:submit|send|provide|leave|share|give|rate|report|offer|complete|earn(?:s|ed|ing)?|receiv(?:e|es|ed|ing)|get|issu(?:e|es|ed|ing)|qualif(?:y|ies)|reward(?:s|ed)?)\\b';
const FEEDBACK_DIRECTIVE_ACTION =
  '\\b(?:submit(?:s|ted|ting)?|send(?:s|ing)?|provide(?:s|d|ing)?|leave(?:s|ing)?|share(?:s|d|ing)?|give(?:s|n|ing)?|rate(?:s|d|ing)?|complete(?:s|d|ing)?)\\b';
const FEEDBACK_REWARD_ACTION =
  '\\b(?:earn(?:s|ed|ing)?|receiv(?:e|es|ed|ing)|get|issu(?:e|es|ed|ing)|qualif(?:y|ies)|reward(?:s|ed|ing)?|refund(?:s|ed|ing)?|grant(?:s|ed|ing)?)\\b';
const FEEDBACK_EXPLICIT_EXCHANGE =
  '\\b(?:in\\s+exchange\\s+for|in\\s+return\\s+for)\\b';
const FEEDBACK_URGENCY =
  '\\b(?:immediately|right\\s+away|now|as\\s+soon\\s+as|every\\s+search|each\\s+search)\\b';
const CONDITIONAL_REWARD_CAP =
  '\\bsubject\\s+to\\s+(?:the\\s+)?(?:daily\\s+)?(?:team\\s+)?cap\\b';
const PERSONAL_REWARD_PROMISE =
  '\\byou\\s+(?:can|may|will)\\s+(?:earn(?:s|ed|ing)?|receiv(?:e|es|ed|ing)|get|qualif(?:y|ies)|be\\s+(?:issued|rewarded|granted))\\b';

function descriptions(language) {
  return (Array.isArray(language) ? language : [language]).map((description) =>
    String(description).replace(/\s+/g, ' ').trim()
  );
}

function statements(description) {
  return description
    .split(/(?<=[.!?])\s+/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function appearsInEitherOrder(statement, first, second) {
  return (
    new RegExp(`${first}${WINDOW}${second}`, 'i').test(statement) ||
    new RegExp(`${second}${WINDOW}${first}`, 'i').test(statement)
  );
}

function containsNativeToolDisplacement(statement) {
  if (
    !new RegExp(TOOL_REFERENCE, 'i').test(statement) ||
    !new RegExp(NATIVE_OR_BUILT_IN, 'i').test(statement)
  ) {
    return false;
  }

  return (
    (appearsInEitherOrder(statement, TOOL_REFERENCE, DISPLACEMENT) &&
      appearsInEitherOrder(statement, NATIVE_OR_BUILT_IN, DISPLACEMENT)) ||
    new RegExp(NEGATED_NATIVE_SELECTION, 'i').test(statement)
  );
}

function containsToolSelection(statement) {
  return (
    new RegExp(TOOL_REFERENCE, 'i').test(statement) &&
    appearsInEitherOrder(statement, TOOL_REFERENCE, SELECTION)
  );
}

function containsNegatedNativeSelection(statement) {
  return new RegExp(NEGATED_NATIVE_SELECTION, 'i').test(statement);
}

function containsAlwaysOrDefaultCoercion(statement) {
  if (!new RegExp(TOOL_REFERENCE, 'i').test(statement)) return false;

  const alwaysSelection = new RegExp(
    `\\balways\\b${WINDOW}${SELECTION}|${SELECTION}${WINDOW}\\balways\\b`,
    'i'
  );
  const defaultSelection = new RegExp(
    `\\bdefault\\s+to\\s+${TOOL_REFERENCE}|${TOOL_REFERENCE}${WINDOW}\\b(?:is|as|should\\s+be|must\\s+be)\\s+(?:the\\s+)?default\\b|\\b(?:make|set)\\b${WINDOW}${TOOL_REFERENCE}${WINDOW}\\b(?:the\\s+)?default\\b|${SELECTION}${WINDOW}\\b(?:by|as)\\s+(?:the\\s+)?default\\b`,
    'i'
  );
  return alwaysSelection.test(statement) || defaultSelection.test(statement);
}

function containsDefaultChoiceCoercion(statement) {
  return new RegExp(
    '\\b(?:make|set)\\b' +
      WINDOW +
      '\\b(?:it|this|the(?:\\s+(?:MCP\\s+)?tool)?)\\b' +
      WINDOW +
      '\\b(?:as|the)\\s+(?:the\\s+)?default(?:\\s+choice|\\s+tool)?\\b|' +
      '\\b(?:it|this|the(?:\\s+(?:MCP\\s+)?tool)?)\\b' +
      WINDOW +
      '\\b(?:should|must|needs?\\s+to)\\s+be\\b' +
      WINDOW +
      '\\b(?:the\\s+)?default(?:\\s+choice|\\s+tool)?\\b',
    'i'
  ).test(statement);
}

function containsReverseDefaultChoiceCoercion(statement) {
  return new RegExp(
    '\\b(?:the\\s+)?default(?:\\s+choice|\\s+tool)?\\b' +
      WINDOW +
      '\\b(?:should|must|needs?\\s+to)\\s+be\\b' +
      WINDOW +
      '\\b(?:it|this|the(?:\\s+(?:MCP\\s+)?tool)?)\\b',
    'i'
  ).test(statement);
}

function containsCriticalSelectionCoercion(statement) {
  if (!/\bcritical\b/i.test(statement)) return false;

  const hasSelection = new RegExp(SELECTION, 'i').test(statement);
  const hasMandatory = new RegExp(MANDATORY, 'i').test(statement);
  const hasToolReference = new RegExp(TOOL_REFERENCE, 'i').test(statement);

  return (
    (hasMandatory && (hasSelection || hasToolReference)) ||
    (hasSelection && hasToolReference)
  );
}

function containsPredicativeMandatorySelection(statement) {
  return new RegExp(
    `${TOOL_REFERENCE}\\s+(?:is|are)\\s+(?:the\\s+)?(?:required|mandatory|necessary)\\b`,
    'i'
  ).test(statement);
}

function containsFeedbackSubmissionDirective(statement) {
  return appearsInEitherOrder(
    statement,
    FEEDBACK_DIRECTIVE_ACTION,
    FEEDBACK
  );
}

function isFactualConditionalReward(statement) {
  if (new RegExp(PERSONAL_REWARD_PROMISE, 'i').test(statement)) {
    return false;
  }

  const hasEligibility = /\beligible\b/i.test(statement);
  const hasCap = new RegExp(CONDITIONAL_REWARD_CAP, 'i').test(statement);
  const hasConditionalModal = /\b(?:can|may)\b/i.test(statement);

  return (hasConditionalModal && (hasEligibility || hasCap)) || (hasEligibility && hasCap);
}

function containsUnconditionalFeedbackReward(statement) {
  const rewardActionPattern = new RegExp(FEEDBACK_REWARD_ACTION, 'gi');
  const creditOrRefundPattern = new RegExp(CREDIT_OR_REFUND, 'i');
  const factualConditionalReward = isFactualConditionalReward(statement);

  for (const match of statement.matchAll(rewardActionPattern)) {
    const start = match.index ?? 0;
    const before = statement.slice(Math.max(0, start - 80), start);
    const after = statement.slice(start + match[0].length, start + match[0].length + 80);
    if (
      /^refund/i.test(match[0]) &&
      !/^\s+(?:(?:a|an|one|\d+)\s+)?credits?\b/i.test(after)
    ) {
      continue;
    }
    if (
      (creditOrRefundPattern.test(before) || creditOrRefundPattern.test(after)) &&
      !factualConditionalReward
    ) {
      return true;
    }
  }

  return false;
}

function containsFeedbackInducement(statement) {
  if (
    !new RegExp(FEEDBACK, 'i').test(statement) ||
    !new RegExp(CREDIT_OR_REFUND, 'i').test(statement)
  ) {
    return false;
  }

  return (
    containsFeedbackSubmissionDirective(statement) ||
    new RegExp(FEEDBACK_EXPLICIT_EXCHANGE, 'i').test(statement) ||
    containsUnconditionalFeedbackReward(statement) ||
    (new RegExp(FEEDBACK_URGENCY, 'i').test(statement) &&
      appearsInEitherOrder(statement, FEEDBACK, FEEDBACK_ACTION))
  );
}

function containsFeedbackSubmission(statement) {
  return containsFeedbackSubmissionDirective(statement);
}

function containsCreditOrRefundReward(statement) {
  return containsUnconditionalFeedbackReward(statement);
}

function containsAdjacentFeedbackInducement(first, second) {
  return (
    (containsFeedbackSubmission(first) &&
      containsCreditOrRefundReward(second)) ||
    (containsCreditOrRefundReward(first) && containsFeedbackSubmission(second))
  );
}

function firstNearbyStatementPair(statements, violates) {
  for (let firstIndex = 0; firstIndex < statements.length; firstIndex += 1) {
    // Inspect the next statement and, at most, one neutral statement between it.
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < Math.min(statements.length, firstIndex + 3);
      secondIndex += 1
    ) {
      if (violates(statements[firstIndex], statements[secondIndex])) {
        return `${statements[firstIndex]} ${statements
          .slice(firstIndex + 1, secondIndex + 1)
          .join(' ')}`;
      }
    }
  }

  return null;
}

function containsNearbyFeedbackInducement(statements) {
  return firstNearbyStatementPair(statements, containsAdjacentFeedbackInducement);
}

function containsAdjacentNativeDisplacement(first, second) {
  return (
    (containsToolSelection(first) && containsNegatedNativeSelection(second)) ||
    (containsNegatedNativeSelection(first) && containsToolSelection(second))
  );
}

function containsAdjacentDefaultCoercion(first, second) {
  return (
    (containsToolSelection(first) &&
      (
        containsDefaultChoiceCoercion(second) ||
        containsReverseDefaultChoiceCoercion(second)
      )) ||
    ((containsDefaultChoiceCoercion(first) ||
      containsReverseDefaultChoiceCoercion(first)) &&
      containsToolSelection(second))
  );
}

function containsNearbyNativeDisplacement(statements) {
  return firstNearbyStatementPair(
    statements,
    containsAdjacentNativeDisplacement
  );
}

function containsNearbyDefaultCoercion(statements) {
  return firstNearbyStatementPair(statements, containsAdjacentDefaultCoercion);
}

// Product decision — Himadri (2026-08-01): factual, conditional refund
// disclosures are permitted. Imperative, urgent, quid-pro-quo, and
// unconditional reward language is not.
const FEEDBACK_INDUCEMENT_RULE = {
  id: 'feedback-credit-refund-inducement',
  label: 'feedback credit/refund inducement (not factual disclosure)',
  violates: containsFeedbackInducement,
};

const NATIVE_DISPLACEMENT_RULE = {
  id: 'firecrawl-native-displacement',
  label: 'Firecrawl-vs-native/built-in displacement',
  violates: containsNativeToolDisplacement,
};

const ALWAYS_DEFAULT_RULE = {
  id: 'always-default-coercion',
  label: 'always/default routing coercion',
  violates: containsAlwaysOrDefaultCoercion,
};

const POLICY_RULES = [
  {
    id: 'comparative-or-promotional-claim',
    label: 'comparative or promotional claim',
    violates: (statement) =>
      /\b(?:most powerful|fastest(?:\s+and\s+(?:most\s+)?reliable)?|most reliable|faster and cheaper|(?:better|faster|cheaper|more reliable|more powerful)\s+than|best\s+(?:tool|choice|option|available))\b/i.test(
        statement
      ),
  },
  NATIVE_DISPLACEMENT_RULE,
  ALWAYS_DEFAULT_RULE,
  {
    id: 'critical-selection-coercion',
    label: 'critical mandatory/selection coercion',
    violates: containsCriticalSelectionCoercion,
  },
  {
    id: 'mandatory-selection-coercion',
    label: 'mandatory routing coercion',
    violates: containsPredicativeMandatorySelection,
  },
  FEEDBACK_INDUCEMENT_RULE,
  {
    id: 'coercive-routing-or-urgency',
    label: 'coercive routing or urgency',
    violates: (statement) =>
      /\b(?:you must|must use|call this immediately|last resort|do not give up)\b/i.test(
        statement
      ),
  },
];

export function findAgentMetadataPolicyViolations(language) {
  return descriptions(language).flatMap((description) => {
    const descriptionStatements = statements(description);
    const violations = descriptionStatements.flatMap((statement) =>
      POLICY_RULES.filter((rule) => rule.violates(statement)).map((rule) => ({
        ...rule,
        statement,
      }))
    );

    for (const [rule, nearbyViolation] of [
      [
        FEEDBACK_INDUCEMENT_RULE,
        containsNearbyFeedbackInducement(descriptionStatements),
      ],
      [
        NATIVE_DISPLACEMENT_RULE,
        containsNearbyNativeDisplacement(descriptionStatements),
      ],
      [
        ALWAYS_DEFAULT_RULE,
        containsNearbyDefaultCoercion(descriptionStatements),
      ],
    ]) {
      if (
        nearbyViolation &&
        !violations.some(
          ({ id, statement }) =>
            id === rule.id && statement === nearbyViolation
        )
      ) {
        violations.push({ ...rule, statement: nearbyViolation });
      }
    }
    return violations;
  });
}

export function assertAgentMetadataPolicy(language, assert) {
  const violations = findAgentMetadataPolicyViolations(language);
  assert.deepEqual(
    violations,
    [],
    `prohibited agent language: ${violations
      .map(({ label, statement }) => `${label}: ${statement}`)
      .join('; ')}`
  );
}
