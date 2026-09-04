/**
 * 工作流 DAG 画布配置（从 dolphinscheduler-ui 的 dag-config.ts 移植，适配 dataforge）。
 * 定义 x6 自定义节点/边/端口的形状、颜色与选中/悬停状态。
 */

export const X6_NODE_NAME = 'dag-task';
export const X6_EDGE_NAME = 'dag-edge';
export const X6_PORT_OUT_NAME = 'dag-port-out';

const EDGE_COLOR = '#555555';
const BG_NODE = '#2d2d30';
const BG_HOVER = '#1e3a5f';
const NODE_BORDER = '#3c3c3c';
const TITLE = '#ffffff';
const STROKE_BLUE = '#0078d4';
const NODE_SHADOW = 'drop-shadow(3px 3px 6px rgba(0, 0, 0, 0.5))';
const EDGE_SHADOW = 'drop-shadow(3px 3px 4px rgba(0, 0, 0, 0.5))';

export const PORT = {
  groups: {
    [X6_PORT_OUT_NAME]: {
      position: {
        name: 'absolute',
        args: {
          x: 200,
          y: 24
        }
      },
      markup: [
        {
          tagName: 'g',
          selector: 'body',
          children: [
            {
              tagName: 'circle',
              selector: 'circle-outer'
            },
            {
              tagName: 'text',
              selector: 'plus-text'
            },
            {
              tagName: 'circle',
              selector: 'circle-inner'
            }
          ]
        }
      ],
      attrs: {
        body: {
          magnet: true
        },
        'plus-text': {
          fontSize: 12,
          fill: '#cccccc',
          text: '+',
          textAnchor: 'middle',
          x: 0,
          y: 3
        },
        'circle-outer': {
          stroke: STROKE_BLUE,
          strokeWidth: 2,
          r: 6,
          fill: BG_NODE
        },
        'circle-inner': {
          r: 4,
          fill: 'transparent'
        }
      }
    }
  }
};

export const PORT_HOVER = {
  groups: {
    [X6_PORT_OUT_NAME]: {
      attrs: {
        'circle-outer': {
          stroke: STROKE_BLUE,
          fill: BG_HOVER,
          r: 8
        },
        'circle-inner': {
          fill: STROKE_BLUE,
          r: 6
        }
      }
    }
  }
};

export const PORT_SELECTED = {
  groups: {
    [X6_PORT_OUT_NAME]: {
      attrs: {
        'plus-text': {
          fill: STROKE_BLUE
        },
        'circle-outer': {
          stroke: STROKE_BLUE,
          fill: BG_NODE
        }
      }
    }
  }
};

/**
 * 实例详情中叠加到节点上的状态徽标（foreignObject + HTML div）。
 * 通过 node.setAttrs 设置 refX/refY 定位在节点上方居中。
 */
export const NODE_STATUS_MARKUP = [
  {
    tagName: 'foreignObject',
    selector: 'status-fo',
    children: [
      {
        tagName: 'div',
        selector: 'status-body',
        ns: 'http://www.w3.org/1999/xhtml'
      }
    ],
    style: {
      width: 132,
      height: 24
    }
  }
];

export const NODE = {
  width: 220,
  height: 48,
  markup: [
    {
      tagName: 'rect',
      selector: 'body',
      className: 'dag-task-body'
    },
    {
      tagName: 'rect',
      selector: 'indicator',
      className: 'dag-task-indicator'
    },
    {
      tagName: 'image',
      selector: 'image'
    },
    {
      tagName: 'text',
      selector: 'title'
    }
  ],
  attrs: {
    body: {
      refWidth: '100%',
      refHeight: '100%',
      rx: 6,
      ry: 6,
      pointerEvents: 'visiblePainted',
      fill: BG_NODE,
      stroke: NODE_BORDER,
      strokeWidth: 2,
      strokeDasharray: 'none',
      filter: 'none'
    },
    indicator: {
      refWidth: 4,
      refHeight: '100%',
      rx: 2,
      ry: 2,
      fill: STROKE_BLUE,
      pointerEvents: 'none'
    },
    image: {
      width: 30,
      height: 30,
      refX: 12,
      refY: 9
    },
    title: {
      refX: 45,
      refY: 18,
      fontFamily: 'Microsoft Yahei',
      fontSize: 15,
      fontWeight: 'bold',
      fill: TITLE,
      strokeWidth: 0
    },
    'status-fo': {
      refX: '50%',
      refY: -32
    }
  },
  ports: {
    ...PORT,
    items: [
      {
        id: X6_PORT_OUT_NAME,
        group: X6_PORT_OUT_NAME
      }
    ]
  }
};

export const NODE_HOVER = {
  attrs: {
    body: {
      fill: '#353538',
      stroke: STROKE_BLUE,
      strokeDasharray: '5,2'
    }
  }
};

export const NODE_SELECTED = {
  attrs: {
    body: {
      filter: NODE_SHADOW,
      fill: BG_NODE,
      stroke: STROKE_BLUE,
      strokeDasharray: '5,2',
      strokeWidth: '1.5'
    },
    title: {
      fill: TITLE
    }
  }
};

export const EDGE = {
  attrs: {
    line: {
      stroke: EDGE_COLOR,
      strokeWidth: 1.5,
      targetMarker: {
        tagName: 'path',
        fill: EDGE_COLOR,
        strokeWidth: 0,
        d: 'M 7 -5 0 0 7 5 Z'
      },
      filter: 'none'
    }
  },
  connector: {
    name: 'rounded'
  },
  router: {
    name: 'er',
    args: {
      offset: 12
    }
  },
  defaultLabel: {
    markup: [
      {
        tagName: 'rect',
        selector: 'body'
      },
      {
        tagName: 'text',
        selector: 'label'
      }
    ],
    attrs: {
      label: {
        fill: '#cccccc',
        fontSize: 16,
        textAnchor: 'middle',
        textVerticalAnchor: 'middle',
        pointerEvents: 'none'
      },
      body: {
        ref: 'label',
        fill: BG_NODE,
        stroke: EDGE_COLOR,
        strokeWidth: 2,
        rx: 4,
        ry: 4,
        refWidth: '140%',
        refHeight: '140%',
        refX: '-20%',
        refY: '-20%'
      }
    },
    position: {
      distance: 0.5,
      options: {
        absoluteDistance: true,
        reverseDistance: true
      }
    }
  }
};

export const EDGE_HOVER = {
  attrs: {
    line: {
      stroke: STROKE_BLUE,
      targetMarker: {
        fill: STROKE_BLUE
      }
    }
  },
  defaultLabel: {
    attrs: {
      label: {
        fill: STROKE_BLUE
      },
      body: {
        fill: BG_NODE,
        stroke: STROKE_BLUE
      }
    }
  }
};

export const EDGE_SELECTED = {
  attrs: {
    line: {
      stroke: STROKE_BLUE,
      targetMarker: {
        fill: STROKE_BLUE
      },
      strokeWidth: 3,
      filter: EDGE_SHADOW
    }
  },
  defaultLabel: {
    attrs: {
      label: {
        fill: STROKE_BLUE
      },
      body: {
        fill: BG_NODE,
        stroke: STROKE_BLUE
      }
    }
  }
};
