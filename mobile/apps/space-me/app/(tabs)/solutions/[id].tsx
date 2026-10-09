/** 方案詳細；找不到方案時回到列表。 */
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useIsWide } from '@hyagent/app-core/layout/useIsWide';
import { useAdvisor } from '@/advisor/AdvisorProvider';
import { findSolution } from '@/content/solutions';
import { SolutionDetailView } from '@/solutions/SolutionDetailView';

export default function SolutionDetail() {
  const wide = useIsWide();
  const advisor = useAdvisor();
  const { id } = useLocalSearchParams<{ id: string }>();
  const solution = findSolution(id);
  if (!solution) return <Redirect href="/solutions" />;
  return (
    <SolutionDetailView
      solution={solution}
      wide={wide}
      onBack={() => (router.canGoBack() ? router.back() : router.navigate('/solutions'))}
      onAsk={advisor.show}
    />
  );
}
