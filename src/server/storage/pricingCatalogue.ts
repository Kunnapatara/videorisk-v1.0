import { PlanDetails } from '../../types';

export const OFFICIAL_PRICING_PLANS: PlanDetails[] = [
  {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    period: 'one-time',
    credits: 10,
    costPerMinuteStandard: 'Free (10 mins)',
    description: 'Explore VideoRisk, test the scanning workflow, and understand your first pre-publish risk report.',
    targetAudience: 'New creators exploring pre-publish risk detection',
    features: [
      '10 free starter credits upon account creation',
      'Standard Scan: up to 10 input minutes',
      'Deep Scan: up to 5 input minutes',
      'Explainable pre-publish risk report',
      'Full evidence timeline & policy context',
      'No payment card required to register'
    ]
  },
  {
    id: 'creator',
    name: 'Creator',
    priceUsd: 9,
    period: 'month',
    credits: 30,
    costPerMinuteStandard: '$0.30 / min',
    description: 'For individual creators who need reliable pre-publish video checks from time to time.',
    targetAudience: 'Individual creators who publish videos occasionally',
    features: [
      '30 credits per monthly billing cycle',
      'Standard Scan: 30 input minutes',
      'Deep Scan: 15 input minutes',
      'Standard & Deep Scan inspection modes',
      '4K with 1080p proxy decode',
      'Re-scan comparison engine',
      'Exportable PDF & JSON reports'
    ],
    highlight: true
  },
  {
    id: 'pro',
    name: 'Pro',
    priceUsd: 19,
    period: 'month',
    credits: 75,
    costPerMinuteStandard: '$0.25 / min',
    description: 'For active creators who regularly publish videos and need more detailed pre-publish analysis.',
    targetAudience: 'Regular publishers who need deeper cross-segment analysis',
    features: [
      '75 credits per monthly billing cycle',
      'Standard Scan: 75 input minutes',
      'Deep Scan: 37 min (+1 credit remaining)',
      'Prioritized analysis queue',
      'Deep cross-segment pattern audit',
      'Unlimited re-scan comparisons',
      'AI disclosure & metadata coherence flags'
    ]
  },
  {
    id: 'agency',
    name: 'Agency / MCN',
    priceUsd: 99,
    period: 'month',
    credits: 600,
    costPerMinuteStandard: '$0.165 / min',
    description: 'For agencies and MCNs managing multiple creators, channels, and video publishing workflows.',
    targetAudience: 'Agencies and MCNs managing multiple channels',
    features: [
      '600 credits per monthly billing cycle',
      'Standard Scan: 600 input minutes',
      'Deep Scan: 300 input minutes',
      'Multiple channel context profiles',
      'Bulk upload analysis throughput',
      'Direct developer API access',
      'Priority technical support'
    ]
  },
  {
    id: 'audit_once',
    name: 'Audit Once',
    priceUsd: 29,
    period: 'one-time',
    credits: 60,
    costPerMinuteStandard: '$0.48 / min',
    description: 'For creators who only need occasional video risk inspections without a recurring monthly commitment.',
    targetAudience: 'Creators needing occasional video risk inspections',
    features: [
      '60 credits (one-time purchase, not recurring)',
      'Standard Scan: 60 input minutes',
      'Deep Scan: 30 input minutes',
      'Standard and Deep Scan modes',
      'Full fix recommendations',
      'Includes 2 re-scan comparisons'
    ]
  }
];

export function getOfficialPlan(planId: string): PlanDetails | undefined {
  return OFFICIAL_PRICING_PLANS.find(p => p.id === planId);
}
