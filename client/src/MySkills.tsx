import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MySkillsView } from '@hyagent/shared';
import { api } from './api';

export default function MySkills() {
  const { i18n } = useTranslation();
  const en = i18n.language.startsWith('en');
  const [data, setData] = useState<MySkillsView | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    void api.mySkills().then((value) => {
      if (alive) { setData(value); setError(false); }
    }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [reload]);
  return <details className="my-skills">
    <summary>{en ? 'My assistant capabilities' : '我的助理能力'}</summary>
    {error ? <p role="alert">{en ? 'Unable to load capabilities.' : '無法載入能力。'} <button type="button" onClick={() => setReload((n) => n + 1)}>{en ? 'Retry' : '重試'}</button></p>
      : !data ? <p role="status">{en ? 'Loading…' : '載入中…'}</p>
      : <>
        {data.roles.length > 0 && <p>{en ? 'Assigned roles: ' : '已指派角色：'}{data.roles.map((r) => r.name).join('、')}</p>}
        <p>{en ? 'Describe your task in chat. Available actions and data depend on your permissions.' : '在對話中描述需求即可使用；實際操作與可讀資料依目前權限判定。'}</p>
        {data.skills.length === 0 ? <p>{en ? 'No task capabilities assigned. Contact your administrator.' : '尚未開通任務能力，請聯絡管理者。'}</p>
          : <ul>{data.skills.map((skill) => <li key={skill.id}><strong>{skill.label}</strong><p>{skill.description}</p></li>)}</ul>}
        <button type="button" onClick={() => setReload((n) => n + 1)}>{en ? 'Refresh capabilities' : '重新整理能力'}</button>
      </>}
  </details>;
}
