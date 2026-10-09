/** AI 產品顧問的開場白與建議問題：依目前所在頁面切換（例如在圖書館方案頁就問圖書館的問題）。 */
import { findSolution } from '@/content/solutions';

export interface AdvisorPrompt {
  greeting: string;
  suggestions: string[];
}

const INTRO = '您好！\n我是 HyAgent，您的 SpaceMe 產品顧問，';

const GENERAL: AdvisorPrompt = {
  greeting: `${INTRO}可以為您介紹 SpaceMe 的解決方案、功能特色與成功案例，或根據您的需求提供建議。`,
  suggestions: ['SpaceMe 是什麼？', '圖書館空間管理有哪些功能？', 'OfficeMe 適合哪些企業？', '有哪些單位使用 SpaceMe？'],
};

const BY_SOLUTION: Record<string, string[]> = {
  library: ['圖書館空間管理有哪些功能？', '討論室和研究小間有什麼不同？', '有哪些圖書館使用 SpaceMe 的案例？', '如何提升空間使用效率？'],
  office: ['OfficeMe 有哪些功能？', '會議室預約怎麼避免空佔？', '彈性座位怎麼運作？', 'OfficeMe 適合多大的企業？'],
  environment: ['智慧環控可以連動哪些設備？', '環控能節省多少能源？', '可以蒐集哪些環境數據？', '既有設備可以整合嗎？'],
  consulting: ['導入 SpaceMe 的流程是什麼？', '導入需要多久時間？', '顧問服務包含哪些項目？', '上線後有哪些支援？'],
};

export function advisorPrompt(pathname: string): AdvisorPrompt {
  const solutionId = /^\/solutions\/([^/]+)/.exec(pathname)?.[1];
  const solution = findSolution(solutionId);
  if (solution) {
    return {
      greeting: `${INTRO}我可以為您介紹${solution.name}的方案、功能特色與成功案例，或根據您的需求提供建議。`,
      suggestions: BY_SOLUTION[solution.id] ?? GENERAL.suggestions,
    };
  }
  if (pathname.startsWith('/features')) {
    return { ...GENERAL, suggestions: ['彈性預約機制怎麼運作？', '個人化選位有什麼好處？', '數據分析報表能看到什麼？', '即時資訊顯示需要哪些設備？'] };
  }
  if (pathname.startsWith('/contact')) {
    return { ...GENERAL, suggestions: ['我想了解導入費用', '可以安排產品展示嗎？', '導入 SpaceMe 的流程是什麼？', '有哪些單位使用 SpaceMe？'] };
  }
  return GENERAL;
}
