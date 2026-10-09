import { useIsWide } from '@hyagent/app-core/layout/useIsWide';
import { useAdvisor } from '@/advisor/AdvisorProvider';
import { FeaturesView } from '@/features/FeaturesView';

export default function Features() {
  const wide = useIsWide();
  const advisor = useAdvisor();
  return <FeaturesView wide={wide} onAsk={advisor.show} />;
}
