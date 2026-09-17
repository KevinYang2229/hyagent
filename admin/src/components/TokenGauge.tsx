import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsMore from 'highcharts/highcharts-more';
import HighchartsReact from 'highcharts-react-official';
import { useTheme, type Theme } from '../theme';
import { formatTokens, niceGaugeMax } from './tokenGauge.util';

// dial gauge（type:'gauge'）需 highcharts-more。v11 為工廠函式；guard 兼容自動註冊版本。
if (typeof HighchartsMore === 'function') {
  (HighchartsMore as (h: typeof Highcharts) => void)(Highcharts);
}

// 位置性色帶（dataviz status 調色盤，固定不隨主題）
const BAND_LOW = '#0ca30c'; // good
const BAND_MID = '#fab219'; // warning
const BAND_HIGH = '#d03b3b'; // critical

/** 讀設計 token 具體色值（Highcharts 需實色字串，CSS 變數無法直接餵）。 */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// theme 參數僅作為 useMemo 依賴（觸發重算取新 token 色），函式體不直接使用
function buildGaugeOptions(tokens: number, _theme: Theme): Highcharts.Options {
  const max = niceGaugeMax(tokens);
  const ink = cssVar('--text-primary', '#0b0b0b');
  const sub = cssVar('--text-secondary', '#52514e');
  const border = cssVar('--border-color', '#e1e0d9');
  return {
    chart: { type: 'gauge', backgroundColor: 'transparent', height: 240 },
    title: { text: undefined },
    credits: { enabled: false },
    tooltip: { enabled: false },
    accessibility: { enabled: false },
    pane: {
      startAngle: -140,
      endAngle: 140,
      background: [{ backgroundColor: 'transparent', borderWidth: 0 }],
    },
    yAxis: {
      min: 0,
      max,
      tickInterval: max / 5,
      lineColor: border,
      tickColor: border,
      tickLength: 8,
      minorTickInterval: undefined,
      labels: {
        distance: 14,
        style: { color: sub, fontSize: '11px' },
        formatter(this: Highcharts.AxisLabelsFormatterContextObject) {
          return formatTokens(Number(this.value));
        },
      },
      plotBands: [
        { from: 0, to: max * 0.6, color: BAND_LOW, thickness: 14 },
        { from: max * 0.6, to: max * 0.85, color: BAND_MID, thickness: 14 },
        { from: max * 0.85, to: max, color: BAND_HIGH, thickness: 14 },
      ],
    },
    series: [
      {
        type: 'gauge',
        name: 'Token',
        data: [Math.min(tokens, max)],
        dial: { backgroundColor: ink, baseWidth: 4, radius: '80%', rearLength: '0%' },
        pivot: { backgroundColor: ink, radius: 5 },
        dataLabels: {
          useHTML: true,
          borderWidth: 0,
          y: 34,
          formatter(this: Highcharts.PointLabelObject) {
            return `<div style="text-align:center"><span style="font-size:26px;font-weight:800;color:${ink}">${formatTokens(tokens)}</span><br/><span style="font-size:11px;color:${sub}">全期間累計 Token</span></div>`;
          },
        },
      },
    ],
  };
}

export default function TokenGauge({ tokens }: { tokens: number }) {
  const theme = useTheme();
  const options = useMemo(() => buildGaugeOptions(tokens, theme), [tokens, theme]);
  return <HighchartsReact highcharts={Highcharts} options={options} />;
}
