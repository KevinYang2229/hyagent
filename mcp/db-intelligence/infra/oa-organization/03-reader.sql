-- 唯讀帳號：逐表授權 SELECT；employee_profile（個資）與 employee_delegate 不授權
CREATE USER IF NOT EXISTS 'hyagent_reader'@'%' IDENTIFIED BY 'reader_dev_only';
GRANT SELECT ON oa_organization_db.company             TO 'hyagent_reader'@'%';
GRANT SELECT ON oa_organization_db.department          TO 'hyagent_reader'@'%';
GRANT SELECT ON oa_organization_db.department_profile  TO 'hyagent_reader'@'%';
GRANT SELECT ON oa_organization_db.employee_job_post   TO 'hyagent_reader'@'%';
GRANT SELECT ON oa_organization_db.employee            TO 'hyagent_reader'@'%';
GRANT SELECT ON oa_organization_db.employee_assignment TO 'hyagent_reader'@'%';
