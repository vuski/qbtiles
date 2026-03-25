import { useRef, useEffect, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { TrafficPoint } from 'qbtiles';
import type { COGTrafficPoint } from '../../lib/cog-query';

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

function fmt(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1024 * 1024) return `${sign}${(abs / 1024 / 1024).toFixed(1)} MB`;
  if (abs >= 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`;
  return `${sign}${abs} B`;
}

interface TrafficChartProps {
  qbtData: TrafficPoint[];
  cogData: COGTrafficPoint[];
}

export function TrafficChart({ qbtData, cogData }: TrafficChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Compute diff text
  const qbtFinal = qbtData.length > 0 ? qbtData[qbtData.length - 1].bytes : 0;
  const cogFinal = cogData.length > 0 ? cogData[cogData.length - 1].bytes : 0;
  const diff = cogFinal - qbtFinal;
  const ratio = qbtFinal > 0 ? ((cogFinal / qbtFinal) * 100).toFixed(0) : '—';
  const hasData = qbtData.length > 0 || cogData.length > 0;

  useEffect(() => {
    if (isMobile || !chartRef.current || !hasData) return;

    if (!instanceRef.current) {
      instanceRef.current = echarts.init(chartRef.current);
    }
    const chart = instanceRef.current;

    // Merge x-axis: all unique request counts
    const maxReq = Math.max(
      qbtData.length > 0 ? qbtData[qbtData.length - 1].request : 0,
      cogData.length > 0 ? cogData[cogData.length - 1].request : 0,
    );

    chart.setOption({
      backgroundColor: 'rgba(0,0,0,0.75)',
      textStyle: { color: '#fff', fontFamily: 'system-ui, sans-serif' },
      grid: { left: 60, right: 20, top: 35, bottom: 30 },
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const lines = params.map(
            (p: any) => `${p.marker} ${p.seriesName}: ${fmt(p.value[1])}`,
          );
          return `Request #${params[0].value[0]}<br/>${lines.join('<br/>')}`;
        },
      },
      legend: {
        data: ['QBTiles', 'COG'],
        textStyle: { color: '#fff', fontSize: 11 },
        top: 4,
      },
      xAxis: {
        type: 'value',
        name: 'Queries',
        nameTextStyle: { color: '#aaa', fontSize: 11 },
        min: 0,
        max: maxReq || 1,
        axisLabel: { color: '#aaa', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
      },
      yAxis: {
        type: 'value',
        name: 'Bytes',
        nameTextStyle: { color: '#aaa', fontSize: 11 },
        axisLabel: {
          color: '#aaa',
          fontSize: 10,
          formatter: (v: number) => fmt(v),
        },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
      },
      series: [
        {
          name: 'QBTiles',
          type: 'line',
          data: qbtData.map((p) => [p.request, p.bytes]),
          lineStyle: { color: '#4a90d9', width: 2 },
          itemStyle: { color: '#4a90d9' },
          symbol: 'circle',
          symbolSize: 4,
          smooth: true,
        },
        {
          name: 'COG',
          type: 'line',
          data: cogData.map((p) => [p.request, p.bytes]),
          lineStyle: { color: '#ff9800', width: 2 },
          itemStyle: { color: '#ff9800' },
          symbol: 'circle',
          symbolSize: 4,
          smooth: true,
        },
      ],
    }, true);

    chart.resize();

    return () => {};
  }, [qbtData, cogData, isMobile, hasData]);

  // Resize chart on window resize
  useEffect(() => {
    const onResize = () => instanceRef.current?.resize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!hasData) return null;

  // Mobile: text only
  if (isMobile) {
    return (
      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 25,
          backgroundColor: 'rgba(0,0,0,0.8)',
          color: '#fff',
          padding: '6px 12px',
          borderRadius: 6,
          fontFamily: 'system-ui, sans-serif',
          fontSize: 12,
          lineHeight: 1.4,
          textAlign: 'center',
          pointerEvents: 'none',
        }}
      >
        <div>COG − QBTiles: <b>{fmt(diff)}</b></div>
        <div>COG / QBTiles: <b>{ratio}%</b></div>
      </div>
    );
  }

  // Desktop: chart + overlay text
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 25,
        pointerEvents: 'auto',
      }}
    >
      <div style={{ position: 'relative' }}>
        <div
          ref={chartRef}
          style={{
            width: 420,
            height: 180,
            borderRadius: 8,
            overflow: 'hidden',
          }}
        />
        {/* Overlay stats */}
        <div
          style={{
            position: 'absolute',
            top: 6,
            right: 8,
            color: '#fff',
            fontFamily: 'system-ui, sans-serif',
            fontSize: 11,
            lineHeight: 1.4,
            textAlign: 'right',
            pointerEvents: 'none',
          }}
        >
          <div>
            Diff: <b style={{ color: '#4fc3f7' }}>{fmt(diff)}</b>
          </div>
          <div>
            COG/QBT: <b style={{ color: '#4fc3f7' }}>{ratio}%</b>
          </div>
        </div>
      </div>
    </div>
  );
}
