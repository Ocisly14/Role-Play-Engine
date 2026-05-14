  "id": "JUNC_1",
  "name": "星辰大道北端",
  "description": "星辰大道的北端尽头。左手边是焚化厂高耸的烟囱冒着灰烟，空气中弥漫着刺鼻的焦灼味。路面上有几道深深的车辙印，地面覆着一层薄薄的灰尘。",
  "parentLocationId": "OUTDOOR",
  "id": "JUNC_2",
  "name": "星辰大道南端三岔口",
  "description": "星辰大道的南端尽头，三条道路在此交汇。向北是星辰大道，向西南是北新街，向南是石榴巷。路口中央有一棵枯萎的老橡树。",
  "parentLocationId": "OUTDOOR",
   "id": "JUNC_3",
  "name": "北新街端点三岔口",
  "description": "北新街的尽头，三条道路在此交汇。向东北是北新街，向东是南新街，向西是旧街。路口铺着碎石，角落有一盏昏暗的路灯。",
  "parentLocationId": "OUTDOOR",
   "id": "JUNC_4",
  "name": "南新街东端三岔口",
  "description": "南新街的东端，三条道路在此交汇。向西是南新街，向北是石榴巷南段，向东南是新月街A大道北。这里是镇中心区域，白天人来人往。",
  "parentLocationId": "OUTDOOR",
  "id": "JUNC_5",
  "name": "新月街十字路口",
  "description": "新月街的核心十字路口，四条道路在此交汇。向西北是新月街A大道北，向西是新月街A大道南，向东是新月街B大道，向南是新月街C大道。路口有一座小型喷水池。",
  "parentLocationId": "OUTDOOR",
  "id": "JUNC_6",
  "name": "石榴巷与日暮大道分叉",
  "description": "石榴巷中段的分叉点，向东北方延伸出日暮大道。向北是石榴巷北段通往星辰大道，向南是石榴巷南段通往南新街。分叉处有一块褪色的路标。",
  "parentLocationId": "OUTDOOR",
  "id": "JUNC_7",
  "name": "旧街西端·火车站前",
  "description": "旧街的西端尽头，正对面是卡森德拉火车站。站前广场铺着不平整的石板，偶尔有火车汽笛声传来。",
  "parentLocationId": "OUTDOOR",
  "id": "JUNC_8",
  "name": "新月街A南西端·警察局前",
  "description": "新月街A大道南的西端尽头，正对面是卡森德拉警察局。路口有一盏明亮的路灯，警察局门前停着一辆警车。",
  "parentLocationId": "OUTDOOR",
  "id": "JUNC_9",
  "name": "新月街B东端",
  "description": "新月街B大道的东端尽头，旁边是一栋二层木屋。街道在此终止，周围是住宅区。",
  "parentLocationId": "OUTDOOR",
   "id": "JUNC_10",
  "name": "新月街C南端",
  "description": "新月街C大道的南端尽头，旁边是菲利普的住宅。街道在此终止，周围是安静的住宅区。",
  "parentLocationId": "OUTDOOR",
  "id": "JUNC_11",
  "name": "日暮大道东端·森林入口",
  "description": "日暮大道的东端尽头，前方是茂密的森林。大道在此处变成泥泞的小路，消失在树木之间。空气中弥漫着松木和腐叶的气息。",
  "parentLocationId": "OUTDOOR",
    "id": "ROAD_1",
  "name": "星辰大道",
  "description": "卡森德拉镇北部的一条南北走向大道，北端尽头是焚化厂，南端分叉连接卡森德拉北新街和石榴巷。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_1",
  "endpointB": "JUNC_2",
  "travelTimeMinutes": 8,
  "alongConnections": [
    {
      "sceneId": "SCN_1_SUB_1",
      "position": 0.5
    }
  ],
  {
  "id": "ROAD_2",
  "name": "卡森德拉北新街",
  "description": "从星辰大道南端向西南延伸的街道，沿途有花店、小餐厅和占卜馆。端点是三岔路口，连接卡森德拉旧街和卡森德拉南新街。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_2",
  "endpointB": "JUNC_3",
  "travelTimeMinutes": 10,
  "alongConnections": [
    {
      "sceneId": "SCN_11_SUB_1",
      "position": 0.2
    },
    {
      "sceneId": "SCN_9_SUB_1",
      "position": 0.5
    },
    {
      "sceneId": "SCN_10_SUB_1",
      "position": 0.8
    }
  ],
  {
  "id": "ROAD_3",
  "name": "卡森德拉南新街",
  "description": "案发的街道，虽然和卡森北新街只隔着一小段距离，但风格给人一种大相径庭的感觉。沿途有酒吧、教堂和五金店。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_3",
  "endpointB": "JUNC_4",
  "travelTimeMinutes": 10,
  "alongConnections": [
    {
      "sceneId": "SCN_16_SUB_1",
      "position": 0.2
    },
    {
      "sceneId": "SCN_17_SUB_1",
      "position": 0.5
    },
    {
      "sceneId": "SCN_18_SUB_1",
      "position": 0.8
    }
  ],
  {
  "id": "ROAD_4",
  "name": "卡森德拉旧街",
  "description": "镇子西侧的老街，从北新街端点向西延伸至火车站。沿途有钟表店和珊德拉的小屋。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_3",
  "endpointB": "JUNC_7",
  "travelTimeMinutes": 12,
  "alongConnections": [
    {
      "sceneId": "SCN_12_SUB_1",
      "position": 0.3
    },
    {
      "sceneId": "SCN_13_SUB_1",
      "position": 0.5
    },
    {
      "sceneId": "SCN_14_SUB_1",
      "position": 0.7
    }
  ],
  "id": "ROAD_5a",
  "name": "石榴巷北段",
  "description": "石榴巷的北段，从星辰大道南端三岔口向南延伸至日暮大道分叉处。巷道较窄，两侧建筑遮挡部分风雪。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_2",
  "endpointB": "JUNC_6",
  "travelTimeMinutes": 6,
  "alongConnections": [],
    "id": "ROAD_5b",
  "name": "石榴巷南段",
  "description": "石榴巷的南段，从日暮大道分叉处向南延伸至南新街东端三岔口。沿途有阿道夫的屋子和一栋镇长的私宅。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_6",
  "endpointB": "JUNC_4",
  "travelTimeMinutes": 6,
  "alongConnections": [
    {
      "sceneId": "SCN_15_SUB_1",
      "position": 0.5
    },
    {
      "sceneId": "SCN_22_SUB_1",
      "position": 0.8
    }
  ],
    "id": "ROAD_6",
  "name": "新月街A大道北",
  "description": "从石榴巷与南新街交汇处向东南延伸的大道，沿途有帕拉迪尔大酒店和马塞尔家。端点是十字路口。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_4",
  "endpointB": "JUNC_5",
  "travelTimeMinutes": 8,
  "alongConnections": [
    {
      "sceneId": "SCN_4_SUB_1",
      "position": 0.3
    },
    {
      "sceneId": "SCN_5_SUB_1",
      "position": 0.7
    }
  ],
    "id": "ROAD_7",
  "name": "新月街A大道南",
  "description": "从新月街十字路口向西延伸的大道，尽头是警察局。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_5",
  "endpointB": "JUNC_8",
  "travelTimeMinutes": 5,
  "alongConnections": [],
    "id": "ROAD_8",
  "name": "新月街B大道",
  "description": "从新月街十字路口向东延伸的大道，沿途有一间二层木屋和地下的下水道系统。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_5",
  "endpointB": "JUNC_9",
  "travelTimeMinutes": 6,
  "alongConnections": [
    {
      "sceneId": "SCN_7_SUB_1",
      "position": 0.5
    }
  ],
    "id": "ROAD_9",
  "name": "新月街C大道",
  "description": "从新月街十字路口向南延伸的大道，沿途有菲利普的住宅。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_5",
  "endpointB": "JUNC_10",
  "travelTimeMinutes": 5,
  "alongConnections": [],
    "id": "ROAD_10",
  "name": "日暮大道",
  "description": "从石榴巷中段分叉向东北延伸的大道，中途路过公墓，尽头是森林和废弃的伐木场。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_6",
  "endpointB": "JUNC_11",
  "travelTimeMinutes": 15,
  "alongConnections": [
    {
      "sceneId": "SCN_19_SUB_1",
      "position": 0.4
    },
    {
      "sceneId": "SCN_20_SUB_1",
      "position": 0.8
    }
  ],