/** 獨立視覺預覽入口：僅供 Metro 手動載入，不是 App 的公開路由。網址 #home、#chat、#products（或 #products-entry 等分類）、#detail、#compare、#intro、#intro-error 切換畫面。 */
import { registerRootComponent } from 'expo';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppBrandingProvider } from '@hyagent/app-core/branding/AppBranding';
import { MessageBubble } from '@hyagent/app-core/chat/MessageBubble';
import { libOneBranding } from '../src/brand/libOneBranding';
import { lib } from '../src/brand/theme';
import { PRODUCTS } from '../src/catalog/catalog';
import Compare from '../app/(tabs)/compare';
import type { CategoryId } from '../src/catalog/catalog';
import { CompareProvider } from '../src/catalog/CompareStore';
import { ProductsView } from '../src/catalog/ProductsView';
import { ProductDetailView } from '../src/catalog/ProductDetailView';
import { ProductStrip } from '../src/chat/ProductStrip';
import { ChatWelcome } from '../src/chat/ChatWelcome';
import { IntroView } from '../src/chrome/IntroView';
import { CONTACT_ENV, contactChannels } from '../src/contact/contact';
import { ContactView } from '../src/contact/ContactView';
import { LibTabBar } from '../src/chrome/LibTabBar';
import { TopBar } from '../src/chrome/TopBar';
import { HomeView } from '../src/home/HomeView';

const noop = () => {};
const TABLE_REPLY = '根據參考資料，兩款設備的定位不同：\n\n## 主要差異\n\n| 項目 | 智慧借閱通關系統 | 智慧閘門 |\n|------|-----------------|---------|\n| **核心功能** | **借閱 + 離館**一次完成 | **身分驗證 + 通行管理** |\n| **使用時機** | 離館時（出口） | 入館時（入口） |\n| **RFID/條碼** | 支援 HF／UHF RFID、條碼辨識館藏 | 不涉及館藏辨識 |\n| **整合對象** | — | 可整合 HyLib、門禁與訪客系統 |\n\n---\n\n### 建議\n- 推動無人化服務：智慧借閱通關系統\n- 需要入館人流統計：智慧閘門';
const REPLY = 'LIB ONE 提供多種自助借還書設備，適用於不同規模的圖書館，協助提升館藏流通效率與讀者使用體驗。以下是主要的自助借還書設備：直立式自助借還書機、桌上型自助借還書機與智慧預約取書櫃。你可以點選「查看產品」了解更多詳細的規格與應用情境。';

function Preview() {
  const { width, height } = useWindowDimensions();
  const wide = width >= 900;
  const screen = typeof window !== 'undefined' ? window.location.hash.slice(1) || 'home' : 'home';
  const path = screen === 'home' ? '/' : screen.startsWith('chat') || screen === 'welcome' ? '/chat' : screen === 'detail' ? '/products/kiosk' : screen.startsWith('compare') ? '/compare' : screen === 'contact' ? '/contact' : '/products';
  const tab = screen === 'home' ? 'index' : screen === 'detail' || screen.startsWith('products') ? 'products' : screen.startsWith('chat') || screen === 'welcome' ? 'chat' : screen;
  if (screen.startsWith('intro')) {
    return <IntroView connected={false} error={screen === 'intro-error' ? '此服務目前未開放訪客使用，請聯絡管理員。' : null} serverUrl="http://192.168.1.10:3000" onRetry={noop} onDone={noop} />;
  }
  return (
    <SafeAreaProvider>
      <AppBrandingProvider value={libOneBranding}>
      <CompareProvider initialIds={screen === 'compare' ? ['kiosk', 'desktop-kiosk'] : screen === 'compare-one' ? ['kiosk'] : []}>
        <View style={{ flex: 1, backgroundColor: lib.greenMist }}>
          <TopBar pathname={path} onBack={noop} onSettings={noop} />
          {screen === 'home' ? <HomeView wide={wide} onAsk={noop} onCategory={noop} /> : null}
          {screen.startsWith('chat') ? (
            <ScrollView contentContainerStyle={{ padding: 20, maxWidth: 1180, width: '100%', alignSelf: 'center' }}>
              <MessageBubble message={{ id: 'u', role: 'user', text: '有哪些自助借還書設備？', at: 0 }} showSuggestions={false} onSuggestion={noop} onEdit={noop} />
              <MessageBubble message={{ id: 'a', role: 'agent', text: window.location.hash === '#chat-table' ? TABLE_REPLY : REPLY, at: 0 }} showSuggestions={false} onSuggestion={noop} onEdit={noop} />
              <ProductStrip text={window.location.hash === '#chat-table' ? TABLE_REPLY : REPLY} wide={wide} />
            </ScrollView>
          ) : null}
          {screen.startsWith('products') ? <ProductsView category={(screen.split('-')[1] || undefined) as CategoryId | undefined} onSelectCategory={noop} onOpenProduct={noop} onCompare={noop} /> : null}
          {screen.startsWith('compare') ? <Compare /> : null}
          {screen === 'contact' ? <ContactView wide={wide || width >= 700} product={PRODUCTS[2]} channels={contactChannels(CONTACT_ENV)} onPrepare={noop} onClearProduct={noop} onAsk={noop} /> : null}
          {screen === 'welcome' ? <View style={{ flex: 1, padding: wide ? 20 : 14 }}><ChatWelcome full wide={width >= 700} onAsk={noop} /></View> : null}
          {screen === 'detail' ? <ProductDetailView product={PRODUCTS.find((p) => p.id === 'kiosk')!} wide={wide} width={width} height={height} inCompare={false} onOpen={noop} onContact={noop} onAsk={noop} onToggleCompare={noop} /> : null}
          <LibTabBar active={tab} onPress={noop} />
        </View>
      </CompareProvider>
      </AppBrandingProvider>
    </SafeAreaProvider>
  );
}
registerRootComponent(Preview);
