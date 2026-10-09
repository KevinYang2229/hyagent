/** 解決方案列表：搜尋狀態留在這個畫面。 */
import { router } from 'expo-router';
import { useState } from 'react';
import { useIsWide } from '@hyagent/app-core/layout/useIsWide';
import { useAdvisor } from '@/advisor/AdvisorProvider';
import { SolutionsView } from '@/solutions/SolutionsView';

export default function Solutions() {
  const wide = useIsWide();
  const advisor = useAdvisor();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <SolutionsView
      wide={wide}
      query={query}
      searchOpen={searchOpen}
      onQuery={setQuery}
      onToggleSearch={() => {
        if (searchOpen) setQuery('');
        setSearchOpen(!searchOpen);
      }}
      onOpen={(id) => router.push(`/solutions/${id}`)}
      onAsk={advisor.show}
    />
  );
}
