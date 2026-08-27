# 知識庫清空前的內容清單（2026-08-27）

清空原因：大檔匯入把 server 打死（容器 OOM），DB 累積 9,000 筆孤兒 chunks。
修正見 `ingestFile` 的串流寫入；本清單記錄清空當下各租戶「原本有什麼」，供重新匯入時對照。

清空範圍：`knowledge_chunks`（23,141 筆／195MB）、`knowledge_tables`（732 筆）、
`knowledge_indexes`（全部）、各租戶 `knowledge_sources.meta` 重設為未建立索引。
**保留**：爬網設定（startUrl／chunkChars／embeddingModel／maxPages／rerank）、
人工設定的推薦問句、租戶的可見性標籤與授權。

## 需要重新匯入的檔案

| 租戶 | 名稱 | 檔案 | 原 chunks | 可見性標籤 |
|---|---|---|---|---|
| `5b6c6d6e8fec334c` | TTS | CC匯出.xlsx | 2,833 | 未標記 |
| `5b6c6d6e8fec334c` | TTS | CP 匯出.xlsx | 3,215 | 未標記 |
| `5b6c6d6e8fec334c` | TTS | TM 匯出.xlsx | 1,619 | 未標記 |
| `5b6c6d6e8fec334c` | TTS | QE匯出.xlsx | 1,943 | 未標記 |
| `8298b6cff6834b93` | CIP | QE匯出.xlsx | 1,943 | `kb:hr` |
| `ec0ee73b5546a385` | hyweb | QE匯出.xlsx | 1,943 | `kb:hr` |
| `default` | 預設租戶 | 2026年員工旅遊補助規則.pdf | 6 | 無 |
| `default` | 預設租戶 | 2026年度旅遊活動報銷單-員工個人旅遊活動.pdf | 1 | 無 |

> `ec0ee73b5546a385` 另有九次失敗的「TM 匯出.xlsx」殘留（9,000 筆孤兒），未列入上表——
> 那份檔案從來沒有匯入成功過，重匯後才會第一次真正進索引。

## 需要重新爬取的網站來源

爬網設定已保留，後台按「重新爬取」即可，不需要任何原始檔。

| 租戶 | startUrl |
|---|---|
| `5b6c6d6e8fec334c` | https://tts-admin-demo-kit.vercel.app/dashboard |
| `8298b6cff6834b93` | https://www.cip.gov.tw/fataan/zh-tw/news/data-list/2A240D8E1DC64911559D5A4819F2F9AA/5D9F2022779207C9A927788B7B14CDD7-info.html |
| `ec0ee73b5546a385` | https://www.hywebsys.com.tw/mp |
| `default` | https://www.hywebsys.com.tw/mp |

## 重匯順序

1. 先確認 server 已部署含串流修正的版本，且 Zeabur 記憶體已上調。
2. 逐租戶重新爬網（網站來源）。
3. 逐檔匯入上表的檔案，匯入時一併帶上原本的可見性標籤。
