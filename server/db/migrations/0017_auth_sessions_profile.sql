-- Assertion 的 hyagent:profile（規格 §4.2.3）隨 Session 保存。
--
-- Assertion 是一次性的，用完即棄；租戶未在 HyAgent 建人員目錄時，/me 與部門相關的
-- 授權判定要靠這份資料補出姓名以外的部門、職稱，因此它必須與 Session 同壽命。
-- 敏感度比照既有的 name 欄位（顯示用組織資訊），不另做加密；sub 仍走 sub_enc。
alter table auth_sessions add column if not exists profile jsonb;
