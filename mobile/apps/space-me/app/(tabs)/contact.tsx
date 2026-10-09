import { useIsWide } from '@hyagent/app-core/layout/useIsWide';
import { useAdvisor } from '@/advisor/AdvisorProvider';
import { CONTACT_ENV, contactChannels } from '@/contact/contact';
import { ContactView } from '@/contact/ContactView';

const CHANNELS = contactChannels(CONTACT_ENV, 'SpaceMe 產品諮詢');

export default function Contact() {
  const wide = useIsWide();
  const advisor = useAdvisor();
  return <ContactView wide={wide} channels={CHANNELS} onAsk={advisor.show} />;
}
